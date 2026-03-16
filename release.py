"""
Asaas Release Helper
A simple GUI to automate version bumping and release tagging.
Run with: python release.py
"""

import json
import subprocess
import tkinter as tk
from tkinter import messagebox, ttk
from pathlib import Path

# Paths
SCRIPT_DIR = Path(__file__).parent
TAURI_CONF = SCRIPT_DIR / "src-tauri" / "tauri.conf.json"
PACKAGE_JSON = SCRIPT_DIR / "package.json"
PATCH_NOTES = SCRIPT_DIR / "src" / "data" / "patch-notes.json"


def read_version():
    """Read current version from tauri.conf.json"""
    with open(TAURI_CONF, 'r') as f:
        data = json.load(f)
    return data.get('version', '1.0.0')


def increment_version(version):
    """Increment patch version (1.0.14 -> 1.0.15)"""
    parts = version.split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    return '.'.join(parts)


def update_version(new_version):
    """Update version in both config files"""
    # Update tauri.conf.json
    with open(TAURI_CONF, 'r') as f:
        tauri_data = json.load(f)
    tauri_data['version'] = new_version
    with open(TAURI_CONF, 'w') as f:
        json.dump(tauri_data, f, indent=2)
    
    # Update package.json
    with open(PACKAGE_JSON, 'r') as f:
        pkg_data = json.load(f)
    pkg_data['version'] = new_version
    with open(PACKAGE_JSON, 'w') as f:
        json.dump(pkg_data, f, indent=2)


def update_patch_notes(version, localized_highlights, localized_team_messages):
    """Save patch notes to src/data/patch-notes.json"""
    if not any(localized_highlights.values()) and not any(localized_team_messages.values()):
        return
        
    # Read existing notes
    if PATCH_NOTES.exists():
        with open(PATCH_NOTES, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                data = {}
    else:
        data = {}

    import datetime
    data[f"v{version}"] = {
        "date": datetime.datetime.now().strftime("%Y-%m-%d"),
        "highlights": localized_highlights,
        "teamMessages": localized_team_messages
    }

    # Save back
    with open(PATCH_NOTES, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def is_git_clean():
    """Check if there are any uncommitted changes"""
    try:
        result = subprocess.run(['git', 'status', '--porcelain'], cwd=SCRIPT_DIR, capture_output=True, text=True, check=True)
        return len(result.stdout.strip()) == 0
    except subprocess.CalledProcessError:
        return False


def run_git_commands(version, commit_msg):
    """Run git commands to commit and push tag"""
    tag = f"v{version}"
    
    try:
        print(f"--- Starting Release {tag} ---")
        
        # Stage all changes
        print("Staging changes...")
        subprocess.run(['git', 'add', '.'], cwd=SCRIPT_DIR, check=True)
        
        # Commit
        print(f"Committing with message: {commit_msg}")
        subprocess.run(['git', 'commit', '-m', commit_msg], cwd=SCRIPT_DIR, check=True)
        
        # Push to main
        print("Pushing to origin main...")
        subprocess.run(['git', 'push', 'origin', 'main'], cwd=SCRIPT_DIR, check=True)
        
        # Create tag
        print(f"Creating tag {tag}...")
        subprocess.run(['git', 'tag', tag], cwd=SCRIPT_DIR, check=True)
        
        # Push tag
        print(f"Pushing tag {tag} to origin...")
        subprocess.run(['git', 'push', 'origin', tag], cwd=SCRIPT_DIR, check=True)
        
        print(f"--- Successfully released {tag} ---")
        return True, f"Successfully released {tag}!"
    except subprocess.CalledProcessError as e:
        error_msg = f"Git error: {e}"
        print(f"❌ {error_msg}")
        return False, error_msg


class ReleaseApp:
    def __init__(self, root):
        self.root = root
        root.title("Asaas Release Helper")
        root.geometry("400x550")
        root.resizable(False, False)
        
        # Style
        style = ttk.Style()
        style.configure('TLabel', font=('Segoe UI', 10))
        style.configure('TButton', font=('Segoe UI', 10))
        style.configure('Header.TLabel', font=('Segoe UI', 14, 'bold'))
        
        # Header
        ttk.Label(root, text="🚀 Release Helper", style='Header.TLabel').pack(pady=15)
        
        # Current version
        current = read_version()
        ttk.Label(root, text=f"Current Version: {current}").pack()
        
        # New version
        frame = ttk.Frame(root)
        frame.pack(pady=15)
        ttk.Label(frame, text="New Version:").pack(side=tk.LEFT, padx=5)
        self.version_var = tk.StringVar(value=increment_version(current))
        self.version_entry = ttk.Entry(frame, textvariable=self.version_var, width=15)
        self.version_entry.pack(side=tk.LEFT)
        
        # Commit message
        ttk.Label(root, text="Commit Message:").pack(pady=(10, 5))
        self.msg_var = tk.StringVar(value=f"Release v{increment_version(current)}")
        self.msg_entry = ttk.Entry(root, textvariable=self.msg_var, width=40)
        self.msg_entry.pack()
        
        # Highlights
        self.localized_highlights = {'en': [], 'ar': [], 'ku': []}
        self.localized_team_msg = {'en': '', 'ar': '', 'ku': ''}
        self.current_lang = 'en'
        
        ttk.Button(root, text="📝 Manage Highlights", command=self.manage_highlights).pack(pady=10)
        self.highlights_btn = root.winfo_children()[-1] # Grabbing last added button
        self.highlights_label = ttk.Label(root, text="0 highlights (EN: 0, AR: 0, KU: 0)", foreground='gray')
        self.highlights_label.pack()

        # Stealth Update
        self.stealth_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(root, text="🤫 Stealth Update (Skip Patch Notes)", variable=self.stealth_var, command=self.toggle_stealth).pack(pady=(10, 0))
        
        # Team Message
        self.has_team_msg = tk.BooleanVar(value=False)
        ttk.Checkbutton(root, text="Include Team Message?", variable=self.has_team_msg, command=self.toggle_team_msg).pack(pady=(10, 0))
        
        # Language selector for team message
        lang_frame = ttk.Frame(root)
        lang_frame.pack(pady=5)
        self.team_lang_var = tk.StringVar(value="en")
        for l in ['en', 'ar', 'ku']:
            ttk.Radiobutton(lang_frame, text=l.upper(), variable=self.team_lang_var, value=l, command=self.switch_team_msg_lang).pack(side=tk.LEFT, padx=5)
            
        self.team_msg_text = tk.Text(root, width=40, height=3, font=('Segoe UI', 9), state='disabled')
        self.team_msg_text.pack(padx=20, pady=5)
        
        # Update message when version changes
        self.version_var.trace('w', self.update_msg)
        
        # Buttons
        btn_frame = ttk.Frame(root)
        btn_frame.pack(pady=10)
        
        ttk.Button(btn_frame, text="🚀 Release", command=self.release).pack(side=tk.LEFT, padx=10)
        ttk.Button(btn_frame, text="❌ Cancel", command=root.quit).pack(side=tk.LEFT, padx=10)
        
        # Status
        self.status_var = tk.StringVar(value="Ready")
        ttk.Label(root, textvariable=self.status_var, foreground='gray').pack(pady=5)
        
        # Local Build Section (Separated from Release)
        ttk.Separator(root, orient='horizontal').pack(fill='x', padx=20, pady=10)
        
        ttk.Label(root, text="Local Development Tools", font=('Segoe UI', 9, 'bold')).pack()
        
        local_btn_frame = ttk.Frame(root)
        local_btn_frame.pack(pady=5)
        
        ttk.Button(local_btn_frame, text="�️ Build Local APK", command=self.build_apk_local_cmd).pack(padx=10)
        
        ttk.Label(root, text="(Use this only to test the APK on your phone manually)", 
                  foreground='#666666', font=('Segoe UI', 8, 'italic')).pack()

    def toggle_stealth(self):
        """Enable/Disable highlighting tools when stealth is on"""
        is_stealth = self.stealth_var.get()
        state = 'disabled' if is_stealth else 'normal'
        
        self.highlights_btn.config(state=state)
        # Keep msg_entry enabled so user can edit it
        self.msg_entry.config(state='normal')
        
        # Disable team message checkbox too
        for child in self.root.winfo_children():
            if isinstance(child, ttk.Checkbutton) and "Team Message" in child.cget("text"):
                child.config(state=state)
        
        current_msg = self.msg_var.get()
        if is_stealth:
            self.status_var.set("Stealth mode active")
        else:
            self.status_var.set("Ready")
            if " (Stealth)" in current_msg:
                self.msg_var.set(current_msg.replace(" (Stealth)", ""))
            elif "(Stealth)" in current_msg:
                self.msg_var.set(current_msg.replace("(Stealth)", ""))

    def update_msg(self, *args):
        self.msg_var.set(f"Release v{self.version_var.get()}")
    
    def build_apk_local_cmd(self):
        """Dedicated command for local build button"""
        if not messagebox.askyesno("Confirm Local Build", 
            "This will build the APK on your computer (takes a few minutes).\n\n"
            "Note: GitHub already builds this automatically during release.\n\n"
            "Continue?"):
            return
            
        success, message = self.build_apk()
        if success:
            messagebox.showinfo("Success", message)
        else:
            messagebox.showerror("Error", message)
        self.status_var.set("Ready")

    def manage_highlights(self):
        """Open a window to manage typed highlights"""
        win = tk.Toplevel(self.root)
        win.title("Manage Highlights")
        win.geometry("500x700")
        win.grab_set()
        
        main_frame = ttk.Frame(win, padding=20)
        main_frame.pack(fill='both', expand=True)
        
        ttk.Label(main_frame, text="Add Update Highlights", font=('Segoe UI', 12, 'bold')).pack(pady=(0, 10))
        
        # Language Selector for highlights list
        self.h_lang_var = tk.StringVar(value="en")
        l_frame = ttk.Frame(main_frame)
        l_frame.pack(pady=5)
        for l in ['en', 'ar', 'ku']:
            ttk.Radiobutton(l_frame, text=l.upper(), variable=self.h_lang_var, value=l, command=lambda: refresh_list()).pack(side=tk.LEFT, padx=5)

        # List of highlights
        list_frame = ttk.Frame(main_frame)
        list_frame.pack(fill='both', expand=True, pady=10)
        
        canvas = tk.Canvas(list_frame)
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=canvas.yview)
        scrollable_frame = ttk.Frame(canvas)
        
        scrollable_frame.bind(
            "<Configure>",
            lambda e: canvas.configure(scrollregion=canvas.bbox("all"))
        )
        
        canvas.create_window((0, 0), window=scrollable_frame, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)
        
        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        
        def refresh_list():
            for widget in scrollable_frame.winfo_children():
                widget.destroy()
            
            lang = self.h_lang_var.get()
            for i, h in enumerate(self.localized_highlights[lang]):
                item = ttk.Frame(scrollable_frame, padding=5)
                item.pack(fill='x', pady=2)
                
                type_color = {'new': 'blue', 'improved': 'green', 'fixed': 'orange'}.get(h['type'], 'black')
                label = ttk.Label(item, text=f"[{h['type'].upper()}] {h['title']}", foreground=type_color, font=('Segoe UI', 9, 'bold'))
                label.pack(side=tk.LEFT, fill='x', expand=True)
                
                content_preview = ttk.Label(item, text=h['content'][:30] + "..." if len(h['content']) > 30 else h['content'], font=('Segoe UI', 8))
                content_preview.pack(side=tk.LEFT, padx=10)
                
                ttk.Button(item, text="X", width=3, command=lambda idx=i: remove_h(idx, lang)).pack(side=tk.RIGHT)
            
            counts = [f"{l.upper()}: {len(self.localized_highlights[l])}" for l in ['en', 'ar', 'ku']]
            self.highlights_label.config(text=f"Highlights ({', '.join(counts)})")

        def remove_h(idx, lang):
            self.localized_highlights[lang].pop(idx)
            refresh_list()

        refresh_list()
        
        # Add new highlight form
        form = ttk.LabelFrame(main_frame, text="Add New Highlight", padding=10)
        form.pack(fill='x', pady=10)
        
        ttk.Label(form, text="Type:").grid(row=0, column=0, sticky='w')
        type_var = tk.StringVar(value="new")
        type_cb = ttk.Combobox(form, textvariable=type_var, values=["new", "improved", "fixed"], state="readonly", width=10)
        type_cb.grid(row=0, column=1, sticky='w', padx=5)
        
        ttk.Label(form, text="Title:").grid(row=1, column=0, sticky='w', pady=5)
        title_entry = ttk.Entry(form, width=40)
        title_entry.grid(row=1, column=1, sticky='w', padx=5)
        
        ttk.Label(form, text="Content:").grid(row=2, column=0, sticky='nw', pady=5)
        content_text = tk.Text(form, width=30, height=3, font=('Segoe UI', 9))
        content_text.grid(row=2, column=1, sticky='w', padx=5, pady=5)
        
        def add_h():
            title = title_entry.get().strip()
            content = content_text.get('1.0', tk.END).strip()
            if not title:
                messagebox.showerror("Error", "Title is required!")
                return
            
            lang = self.h_lang_var.get()
            self.localized_highlights[lang].append({
                'type': type_var.get(),
                'title': title,
                'content': content
            })
            title_entry.delete(0, tk.END)
            content_text.delete('1.0', tk.END)
            refresh_list()
            
        ttk.Button(form, text="➕ Add Highlight", command=add_h).grid(row=3, column=1, sticky='e', pady=5)
        
        ttk.Button(main_frame, text="✅ Done", command=win.destroy).pack(pady=10)

    def switch_team_msg_lang(self):
        """Save current team message and switch view to another language"""
        old_lang = self.current_lang
        new_lang = self.team_lang_var.get()
        
        # Save current text to dictionary
        self.localized_team_msg[old_lang] = self.team_msg_text.get('1.0', tk.END).strip()
        
        # Switch current language
        self.current_lang = new_lang
        
        # Update text area with new language content
        self.team_msg_text.config(state='normal')
        self.team_msg_text.delete('1.0', tk.END)
        self.team_msg_text.insert('1.0', self.localized_team_msg[new_lang])
        if not self.has_team_msg.get():
             self.team_msg_text.config(state='disabled')

    def toggle_team_msg(self):
        """Enable/Disable team message text area"""
        if self.has_team_msg.get():
            self.team_msg_text.config(state='normal')
            self.team_msg_text.focus()
        else:
            # Save before disabling
            self.localized_team_msg[self.current_lang] = self.team_msg_text.get('1.0', tk.END).strip()
            self.team_msg_text.delete('1.0', tk.END)
            self.team_msg_text.config(state='disabled')

    def build_apk(self):
        """Run android build and rename APK"""
        try:
            self.status_var.set("Building Local Android APK...")
            self.root.update()
            
            # Run npm run android:build (tauri android build --debug)
            # This version is AUTOMATICALLY SIGNED and can be installed on phones immediately.
            subprocess.run(['npm.cmd', 'run', 'android:build'], cwd=SCRIPT_DIR, check=True, shell=True)
            
            # Potential Tauri APK output paths
            potential_paths = [
                SCRIPT_DIR / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs" / "apk" / "universal" / "release" / "app-universal-release-unsigned.apk",
                SCRIPT_DIR / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs" / "apk" / "release" / "app-release-unsigned.apk",
                SCRIPT_DIR / "src-tauri" / "gen" / "android" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"
            ]
            
            apk_path = None
            for p in potential_paths:
                if p.exists():
                    apk_path = p
                    break
            
            output_apk = SCRIPT_DIR / "Asaas.apk"
            
            if apk_path:
                import shutil
                shutil.copy2(apk_path, output_apk)
                self.status_var.set("Ready")
                return True, "APK built and renamed to Asaas.apk"
            else:
                self.status_var.set("Failed")
                return False, f"APK not found at {apk_path}"
                
        except subprocess.CalledProcessError as e:
            self.status_var.set("Failed")
            return False, f"Build error: {e}"
        except Exception as e:
            self.status_var.set("Failed")
            return False, f"Unexpected error: {e}"

    def release(self):
        # Sanitize version (remove leading 'v')
        version = self.version_var.get().strip()
        if version.lower().startswith('v'):
            version = version[1:]
            
        msg = self.msg_var.get()
        
        if not version or not msg:
            messagebox.showerror("Error", "Version and message are required!")
            return
        
        # Pre-flight check
        if not is_git_clean():
            if not messagebox.askyesno("Uncommitted Changes", 
                "You have uncommitted changes in your repository.\n\n" +
                "These will be included in the release commit automatically.\n" +
                "Continue?"):
                return

        steps = [
            f"1. Update version to {version}",
            f"2. Commit: {msg}",
            f"3. Create tag v{version}",
            f"4. Push to GitHub (Triggers Auto-Releases)"
        ]
            
        if not messagebox.askyesno("Confirm Release", 
            "This will start the GitHub release process:\n\n" + "\n".join(steps) + "\n\nContinue?"):
            return
        
        self.status_var.set("Updating version...")
        self.root.update()
        
        try:
            update_version(version)
            
            if not self.stealth_var.get():
                # Save current team message before finalizing
                self.localized_team_msg[self.current_lang] = self.team_msg_text.get('1.0', tk.END).strip()
                
                team_messages = {l: self.localized_team_msg[l] for l in ['en', 'ar', 'ku'] if self.localized_team_msg[l]}
                update_patch_notes(version, self.localized_highlights, team_messages)
            else:
                print("Skipping patch notes (Stealth mode)")
            
            self.status_var.set("Pushing to GitHub...")
            self.root.update()
            
            success, message = run_git_commands(version, msg)
            
            if success:
                messagebox.showinfo("Success", message + "\n\nGitHub will now build both Windows and Android versions automatically!")
                self.root.quit()
            else:
                messagebox.showerror("Error", message)
                self.status_var.set("Failed")
        except Exception as e:
            messagebox.showerror("Error", str(e))
            self.status_var.set("Failed")


if __name__ == "__main__":
    root = tk.Tk()
    app = ReleaseApp(root)
    root.mainloop()
