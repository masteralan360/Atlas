import os
import json
import glob
import boto3
from botocore.config import Config
from pathlib import Path
from datetime import datetime

def get_s3_client():
    account_id = os.environ.get("R2_ACCOUNT_ID")
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    
    if not all([account_id, access_key, secret_key]):
        # Fallback to older worker-based env vars if S3 ones are missing
        # but print a warning because this will fail for large files
        print("Warning: R2 S3 credentials (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY) missing.")
        print("Large file uploads (>100MB) will likely fail if using the Worker proxy.")
        return None

    endpoint_url = f"https://{account_id}.r2.cloudflarestorage.com"
    
    return boto3.client(
        service_name='s3',
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version='s3v4'),
        region_name='auto' # R2 uses 'auto'
    )

def is_sau_enabled():
    """Check if Skip Auto-Update (SAU) is enabled via .release-config.json."""
    try:
        if os.path.exists(".release-config.json"):
            with open(".release-config.json", 'r') as f:
                release_config = json.load(f)
            return release_config.get("skip_latest_json", False)
    except Exception as e:
        print(f"Warning: Could not read .release-config.json: {e}")
    return False

def clear_updates():
    if is_sau_enabled():
        print("SAU is enabled; skipping atlas-updates/ clear entirely.")
        return

    print("Clearing atlas-updates/ in R2...")
    bucket_name = os.environ.get("R2_BUCKET_NAME", "atlas")
    s3 = get_s3_client()
    
    if not s3:
        print("Error: Cannot clear updates without S3 credentials.")
        exit(1)

    try:
        paginator = s3.get_paginator('list_objects_v2')
        for page in paginator.paginate(Bucket=bucket_name, Prefix='atlas-updates/'):
            if 'Contents' in page:
                delete_keys = [{'Key': obj['Key']} for obj in page['Contents']]
                print(f"Deleting {len(delete_keys)} objects...")
                s3.delete_objects(Bucket=bucket_name, Delete={'Objects': delete_keys})
    except Exception as e:
        print(f"Error clearing updates: {e}")
        exit(1)

def upload_assets():
    if is_sau_enabled():
        print("SAU is enabled; skipping all atlas-updates/ uploads entirely.")
        print("   Existing R2 update files will remain untouched.")
        return

    print("Starting asset upload to R2...")
    bucket_name = os.environ.get("R2_BUCKET_NAME", "atlas")
    s3 = get_s3_client()
    
    if not s3:
        print("Error: R2 S3 credentials missing. Cannot proceed with robust upload.")
        exit(1)

    # Broaden patterns to find assets wherever they might be in the bundle dir
    windows_patterns = [
        "src-tauri/target/release/bundle/msi/*.msi",
        "src-tauri/target/release/bundle/msi/*.msi.sig",
        "src-tauri/target/release/bundle/nsis/*.exe",
        "src-tauri/target/release/bundle/nsis/*.exe.sig",
        "src-tauri/target/release/bundle/updater/latest.json",
        "src-tauri/target/release/bundle/latest.json",
        "**/target/release/bundle/updater/latest.json"
    ]
    
    # Find Android assets
    android_patterns = [
        "src-tauri/gen/android/app/build/outputs/apk/universal/release/Atlas_*.apk",
        "src-tauri/gen/android/app/build/outputs/apk/debug/*.apk",
        "**/outputs/apk/**/Atlas_*.apk"
    ]
    
    all_files = []
    print("Searching for files using patterns...")
    for p in windows_patterns + android_patterns:
        matches = glob.glob(p, recursive=True)
        if matches:
            print(f"Pattern '{p}' matched: {matches}")
        all_files.extend(matches)
        
    if not all_files:
        print("No assets found to upload!")
        return

    # Fetch existing latest.json from R2 so we can merge
    remote_data = None
    try:
        print("Attempting to fetch existing latest.json from R2...")
        response = s3.get_object(Bucket=bucket_name, Key='atlas-updates/latest.json')
        remote_data = json.loads(response['Body'].read().decode('utf-8'))
        print("Successfully fetched existing latest.json from R2")
    except s3.exceptions.NoSuchKey:
        print("No existing latest.json found on R2")
    except Exception as e:
        print(f"Warning: Error fetching existing latest.json: {e}")

    # Determine version from tauri conf and min_version from package.json
    version = "0.0.0"
    local_min_version = "0.0.0"
    try:
        with open("src-tauri/tauri.conf.json", 'r') as f:
            version = json.load(f).get("version", "0.0.0")
            
        with open("package.json", 'r') as f:
            local_min_version = json.load(f).get("min_version", "0.0.0")
    except Exception as e:
        print(f"Warning: Could not read version/min_version: {e}")

    # Preserve min_version from remote if it exists
    remote_min_version = remote_data.get("min_version", "0.0.0") if remote_data else "0.0.0"

    # Use remote data if it matches our version, else start fresh
    if remote_data and remote_data.get("version") == version:
        data = remote_data
    else:
        data = {
            "version": version,
            "notes": f"Release {version}",
            "pub_date": datetime.utcnow().isoformat() + "Z",
            "platforms": {}
        }

    # Prioritize local min_version if it's set in tauri.conf.json, else carry remote forward
    data["min_version"] = local_min_version if local_min_version != "0.0.0" else remote_min_version
        
    if "platforms" not in data:
        data["platforms"] = {}

    # Process local latest.json if generated by Tauri
    local_latest_json_path = None
    for f_path in all_files:
        if os.path.basename(f_path) == "latest.json":
            local_latest_json_path = f_path
            if "/updater/" in f_path:
                break
                
    # We'll use this base URL for update links
    # If the user still uses the worker for downloads, we can keep VITE_R2_WORKER_URL
    # but direct R2 public bucket URLs are often better. 
    # For now, let's keep it flexible or use the public URL if account_id is known.
    base_download_url = os.environ.get("VITE_R2_WORKER_URL") 
    if base_download_url:
        if not base_download_url.endswith('/'): base_download_url += '/'
    else:
        # Fallback to S3-style public URL if needed, but Worker is probably preferred for downloads
        base_download_url = f"https://{bucket_name}.{os.environ.get('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com/"

    if local_latest_json_path and os.path.exists(local_latest_json_path):
        print(f"Merging locally generated {local_latest_json_path}...")
        try:
            with open(local_latest_json_path, 'r') as f:
                local_data = json.load(f)
            # Merge its platforms
            for platform, details in local_data.get("platforms", {}).items():
                if "url" in details:
                    filename = os.path.basename(details["url"])
                    details["url"] = f"{base_download_url}atlas-updates/{filename}"
                    data["platforms"][platform] = details
                    print(f"Merged local platform rules: {platform}")
        except Exception as e:
            print(f"Error reading local latest.json: {e}")

    # Retain both installer types so existing installations update in place:
    # MSI remains available for legacy/system-wide installations, while NSIS
    # remains the current-user, no-UAC path.
    windows_msi = None
    windows_nsis = None
    for f_path in all_files:
        if f_path.endswith(".msi") and windows_msi is None:
            windows_msi = f_path
        elif f_path.endswith(".exe") and windows_nsis is None:
            windows_nsis = f_path

    def windows_update_details(installer_path):
        sig_path = f"{installer_path}.sig"
        signature = ""
        if os.path.exists(sig_path):
            try:
                with open(sig_path, 'r') as f:
                    signature = f.read().strip()
            except Exception:
                pass

        filename = os.path.basename(installer_path)
        return {
            "signature": signature,
            "url": f"{base_download_url}atlas-updates/{filename}"
        }

    if windows_msi:
        data["platforms"]["windows-x86_64-msi"] = windows_update_details(windows_msi)

    if windows_nsis:
        data["platforms"]["windows-x86_64-nsis"] = windows_update_details(windows_nsis)

    # Older builds that do not send their installer type use the generic key.
    # Point them to NSIS for the one-time WiX/MSI-to-NSIS migration. The
    # generated NSIS installer detects the old MSI and removes it before
    # installing the current-user app. New builds explicitly request one of
    # the installer-specific keys above, so MSI remains a compatibility path.
    if windows_nsis:
        data["platforms"]["windows-x86_64"] = windows_update_details(windows_nsis)
    elif windows_msi:
        # Do not publish a broken generic target if an NSIS artifact failed to
        # build; legacy clients can still receive the compatibility MSI.
        data["platforms"]["windows-x86_64"] = windows_update_details(windows_msi)

    if windows_msi or windows_nsis:
        mapped_installers = []
        if windows_msi:
            mapped_installers.append(os.path.basename(windows_msi))
        if windows_nsis:
            mapped_installers.append(os.path.basename(windows_nsis))
        print(f"Mapped Windows updater platforms to: {', '.join(mapped_installers)}")

    # Dynamically Map Android
    android_apk = None
    for f_path in all_files:
        basename = os.path.basename(f_path)
        if basename.startswith("Atlas_") and basename.endswith(".apk"):
            android_apk = f_path
            break
        elif f_path.endswith(".apk") and not android_apk:
            android_apk = f_path
            
    if android_apk:
        filename = os.path.basename(android_apk)
        details = {
            "signature": "",
            "url": f"{base_download_url}atlas-updates/{filename}"
        }
        for plat in ["android-aarch64", "android-armv7", "android-x86_64", "android-i686", "android"]:
            data["platforms"][plat] = details
        print(f"Dynamically mapped android platforms to {filename}")

    # Write merged JSON to disk
    final_latest_json = "latest.json"
    with open(final_latest_json, 'w') as f:
        json.dump(data, f, indent=2)
    print(f"Generated final {final_latest_json} with platforms: {list(data.get('platforms', {}).keys())}")
    
    # Filter files for upload
    files_to_upload = []
    if len(data.get("platforms", {})) > 0:
        files_to_upload.append(final_latest_json)
    
    for f in all_files:
        if os.path.basename(f) == "latest.json":
            continue
        files_to_upload.append(f)

    # Upload all
    for file_path in files_to_upload:
        filename = os.path.basename(file_path)
        r2_key = f"atlas-updates/{filename}"
        print(f"Uploading {file_path} to {r2_key}...")
        
        content_type = "application/json" if filename.endswith(".json") else "application/octet-stream"
        if filename.endswith(".msi"): content_type = "application/x-msi"
        elif filename.endswith(".exe"): content_type = "application/x-msdos-program"
        elif filename.endswith(".apk"): content_type = "application/vnd.android.package-archive"
        
        try:
            s3.upload_file(
                Filename=file_path,
                Bucket=bucket_name,
                Key=r2_key,
                ExtraArgs={'ContentType': content_type}
            )
            print(f"Successfully uploaded {filename}")
        except Exception as e:
            print(f"Error uploading {filename}: {e}")
            exit(1)

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "clear":
        clear_updates()
    else:
        upload_assets()

