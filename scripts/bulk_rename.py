import os
import re

def replace_in_file(filepath):
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read()
            
        # Specific exclusions
        # Don't replace asaas-r2-proxy
        # We will temporarily mask it
        masked = content.replace("asaas-r2-proxy", "___R2_PROXY___")
        
        # Replacements
        masked = masked.replace("Asaas", "Atlas")
        masked = masked.replace("asaas", "atlas")
        masked = masked.replace("ASAAS", "ATLAS")
        
        # Unmask
        final_content = masked.replace("___R2_PROXY___", "asaas-r2-proxy")
        
        if final_content != content:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(final_content)
            print(f"Updated {filepath}")
    except Exception as e:
        print(f"Error processing {filepath}: {e}")

def process_dir(directory):
    for root, dirs, files in os.walk(directory):
        # Skip node_modules, .git, target, gen, dist
        dirs[:] = [d for d in dirs if d not in ['.git', 'node_modules', 'target', 'gen', 'dist', '.wwebjs_cache']]
        for file in files:
            if file.endswith(('.ts', '.tsx', '.md', '.json', '.html', '.yml', '.yaml', '.xml', '.toml')):
                filepath = os.path.join(root, file)
                replace_in_file(filepath)

if __name__ == "__main__":
    process_dir("docs")
    process_dir("src")
    process_dir("src-tauri")
    process_dir(".github")
    replace_in_file("README.md")
    print("Done")
