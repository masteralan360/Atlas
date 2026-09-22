"""
Asaas Release Helper
A simple GUI to automate version bumping and release tagging.
Run with: python release.py
"""

import json
import subprocess
import datetime
from pathlib import Path

from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QTextEdit, QPushButton, QComboBox, QCheckBox,
    QRadioButton, QFrame, QScrollArea, QMessageBox, QButtonGroup,
    QSizePolicy, QDialog, QGroupBox, QGridLayout
)
from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QFont

import sys

# ── Paths ──────────────────────────────────────────────────────────────────────
SCRIPT_DIR  = Path(__file__).parent
TAURI_CONF  = SCRIPT_DIR / "src-tauri" / "tauri.conf.json"
PACKAGE_JSON = SCRIPT_DIR / "package.json"
PATCH_NOTES = SCRIPT_DIR / "src" / "data" / "patch-notes.json"
RELEASE_CONFIG = SCRIPT_DIR / ".release-config.json"
RELEASE_MANAGED_FILES = (TAURI_CONF, PACKAGE_JSON, PATCH_NOTES, RELEASE_CONFIG)

RTL_LANGS = ('ar', 'ku')


# ── Helpers ────────────────────────────────────────────────────────────────────
def read_version():
    with open(TAURI_CONF, 'r') as f:
        tauri_data = json.load(f)
    with open(PACKAGE_JSON, 'r') as f:
        pkg_data = json.load(f)
    min_v = pkg_data.get('min_version') or tauri_data.get('min_version', '0.0.0')
    return tauri_data.get('version', '1.0.0'), min_v


def increment_version(version):
    parts = version.split('.')
    parts[-1] = str(int(parts[-1]) + 1)
    return '.'.join(parts)


def update_version(new_version, new_min_version):
    with open(TAURI_CONF, 'r') as f:
        tauri_data = json.load(f)
    tauri_data['version'] = new_version
    if 'min_version' in tauri_data:
        del tauri_data['min_version']
    with open(TAURI_CONF, 'w') as f:
        json.dump(tauri_data, f, indent=2)

    with open(PACKAGE_JSON, 'r') as f:
        pkg_data = json.load(f)
    pkg_data['version'] = new_version
    pkg_data['min_version'] = new_min_version
    with open(PACKAGE_JSON, 'w') as f:
        json.dump(pkg_data, f, indent=2)


def update_patch_notes(version, localized_highlights, localized_team_messages):
    if not any(localized_highlights.values()) and not any(localized_team_messages.values()):
        return
    if PATCH_NOTES.exists():
        with open(PATCH_NOTES, 'r', encoding='utf-8') as f:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                data = {}
    else:
        data = {}

    data[f"v{version}"] = {
        "date": datetime.datetime.now().strftime("%Y-%m-%d"),
        "highlights": localized_highlights,
        "teamMessages": localized_team_messages,
    }
    with open(PATCH_NOTES, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def is_git_clean():
    try:
        result = subprocess.run(
            ['git', 'status', '--porcelain'],
            cwd=SCRIPT_DIR, capture_output=True, text=True, check=True
        )
        return len(result.stdout.strip()) == 0
    except subprocess.CalledProcessError:
        return False


def has_staged_changes():
    """Return whether the Git index contains changes ready to commit."""
    try:
        result = subprocess.run(
            ['git', 'diff', '--cached', '--quiet'],
            cwd=SCRIPT_DIR, capture_output=True, check=False
        )
        return result.returncode == 1
    except OSError:
        return False


def unstaged_release_managed_files():
    """Return release metadata files with unstaged or untracked changes.

    Staged-only releases stage the current release metadata after it is updated.
    Refuse to do that when one of those files already has local unstaged work, so
    that the helper never stages an unrelated edit in a release-managed file.
    """
    try:
        modified = subprocess.run(
            ['git', 'diff', '--name-only'],
            cwd=SCRIPT_DIR, capture_output=True, text=True, check=True
        ).stdout.splitlines()
        untracked = subprocess.run(
            ['git', 'ls-files', '--others', '--exclude-standard'],
            cwd=SCRIPT_DIR, capture_output=True, text=True, check=True
        ).stdout.splitlines()
    except subprocess.CalledProcessError:
        return []

    managed_paths = {
        str(path.relative_to(SCRIPT_DIR)).replace('\\', '/')
        for path in RELEASE_MANAGED_FILES
    }
    changed_paths = {
        path.replace('\\', '/')
        for path in [*modified, *untracked]
    }
    return sorted(managed_paths & changed_paths)


def stage_release_metadata():
    """Stage only the files the release helper updates itself."""
    paths = [
        str(path.relative_to(SCRIPT_DIR))
        for path in RELEASE_MANAGED_FILES
        if path.exists()
    ]
    subprocess.run(['git', 'add', '--', *paths], cwd=SCRIPT_DIR, check=True)


def optimize_tip_videos():
    """Re-encode any raw videos dropped into public/tips before they get committed."""
    print("--- Optimizing tip videos ---")
    try:
        subprocess.run(['npm.cmd', 'run', 'optimize:tips'], cwd=SCRIPT_DIR, check=True, shell=True)
        print("--- Tip video optimization done ---")
    except subprocess.CalledProcessError as e:
        print(f"⚠️ Tip video optimization failed: {e}")


def run_git_commands(version, commit_msg, stage_all_changes=True):
    tag = f"v{version}"
    try:
        print(f"--- Starting Release {tag} ---")
        if stage_all_changes:
            subprocess.run(['git', 'add', '.'], cwd=SCRIPT_DIR, check=True)
        subprocess.run(['git', 'commit', '-m', commit_msg], cwd=SCRIPT_DIR, check=True)
        subprocess.run(['git', 'push', 'origin', 'main'], cwd=SCRIPT_DIR, check=True)
        subprocess.run(['git', 'tag', tag], cwd=SCRIPT_DIR, check=True)
        subprocess.run(['git', 'push', 'origin', tag], cwd=SCRIPT_DIR, check=True)
        print(f"--- Successfully released {tag} ---")
        return True, f"Successfully released {tag}!"
    except subprocess.CalledProcessError as e:
        error_msg = f"Git error: {e}"
        print(f"❌ {error_msg}")
        return False, error_msg


# ── RTL text helper ────────────────────────────────────────────────────────────
def apply_rtl(widget, lang):
    """Set text direction on a QLineEdit or QTextEdit based on language."""
    is_rtl = lang in RTL_LANGS
    direction = Qt.RightToLeft if is_rtl else Qt.LeftToRight
    alignment = Qt.AlignRight if is_rtl else Qt.AlignLeft
    widget.setLayoutDirection(direction)
    if isinstance(widget, QTextEdit):
        widget.setAlignment(alignment)
    else:
        widget.setAlignment(alignment)


# ── Highlights Dialog ──────────────────────────────────────────────────────────
class HighlightsDialog(QDialog):
    def __init__(self, parent, localized_highlights):
        super().__init__(parent)
        self.setWindowTitle("Manage Highlights")
        self.resize(540, 680)
        self.localized_highlights = localized_highlights

        layout = QVBoxLayout(self)
        layout.setSpacing(10)

        title = QLabel("Add Update Highlights")
        title.setFont(QFont("Segoe UI", 13, QFont.Bold))
        layout.addWidget(title)

        # Language selector
        lang_row = QHBoxLayout()
        self.lang_group = QButtonGroup(self)
        for i, lang in enumerate(['en', 'ar', 'ku']):
            rb = QRadioButton(lang.upper())
            rb.setChecked(lang == 'en')
            rb.toggled.connect(self.refresh_list)
            self.lang_group.addButton(rb, i)
            lang_row.addWidget(rb)
        lang_row.addStretch()
        layout.addLayout(lang_row)

        # Scroll area for list
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.list_container = QWidget()
        self.list_layout = QVBoxLayout(self.list_container)
        self.list_layout.setAlignment(Qt.AlignTop)
        self.scroll.setWidget(self.list_container)
        layout.addWidget(self.scroll, stretch=1)

        # Add form
        form_box = QGroupBox("Add New Highlight")
        form = QGridLayout(form_box)

        form.addWidget(QLabel("Type:"), 0, 0)
        self.type_cb = QComboBox()
        self.type_cb.addItems(["new", "improved", "fixed"])
        form.addWidget(self.type_cb, 0, 1)

        form.addWidget(QLabel("Title:"), 1, 0)
        self.title_edit = QLineEdit()
        form.addWidget(self.title_edit, 1, 1)

        form.addWidget(QLabel("Content:"), 2, 0, Qt.AlignTop)
        self.content_edit = QTextEdit()
        self.content_edit.setFixedHeight(70)
        form.addWidget(self.content_edit, 2, 1)

        add_btn = QPushButton("➕ Add Highlight")
        add_btn.clicked.connect(self.add_highlight)
        form.addWidget(add_btn, 3, 1, Qt.AlignRight)

        layout.addWidget(form_box)

        done_btn = QPushButton("✅ Done")
        done_btn.clicked.connect(self.accept)
        layout.addWidget(done_btn, alignment=Qt.AlignRight)

        # Connect lang change to update RTL on input fields
        self.lang_group.buttonToggled.connect(self._update_input_direction)
        self.refresh_list()

    def current_lang(self):
        idx = self.lang_group.checkedId()
        return ['en', 'ar', 'ku'][idx]

    def _update_input_direction(self):
        lang = self.current_lang()
        apply_rtl(self.title_edit, lang)
        apply_rtl(self.content_edit, lang)

    def refresh_list(self):
        # Clear
        while self.list_layout.count():
            item = self.list_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        lang = self.current_lang()
        self._update_input_direction()

        for i, h in enumerate(self.localized_highlights[lang]):
            row = QFrame()
            row.setFrameShape(QFrame.StyledPanel)
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(6, 4, 6, 4)

            color = {'new': '#2563eb', 'improved': '#16a34a', 'fixed': '#d97706'}.get(h['type'], '#000')
            badge = QLabel(f"[{h['type'].upper()}]")
            badge.setStyleSheet(f"color: {color}; font-weight: bold;")
            row_layout.addWidget(badge)

            preview = h['title']
            if len(h['content']) > 0:
                preview += f" — {h['content'][:30]}{'...' if len(h['content']) > 30 else ''}"
            lbl = QLabel(preview)
            lbl.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
            if lang in RTL_LANGS:
                lbl.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
                lbl.setLayoutDirection(Qt.RightToLeft)
            row_layout.addWidget(lbl)

            del_btn = QPushButton("✕")
            del_btn.setFixedWidth(30)
            del_btn.clicked.connect(lambda _, idx=i, l=lang: self.remove_highlight(idx, l))
            row_layout.addWidget(del_btn)

            self.list_layout.addWidget(row)

    def add_highlight(self):
        lang = self.current_lang()
        title = self.title_edit.text().strip()
        content = self.content_edit.toPlainText().strip()
        if not title:
            QMessageBox.critical(self, "Error", "Title is required!")
            return
        self.localized_highlights[lang].append({
            'type': self.type_cb.currentText(),
            'title': title,
            'content': content,
        })
        self.title_edit.clear()
        self.content_edit.clear()
        self.refresh_list()

    def remove_highlight(self, idx, lang):
        self.localized_highlights[lang].pop(idx)
        self.refresh_list()


# ── Main Window ────────────────────────────────────────────────────────────────
class ReleaseApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Asaas Release Helper")
        self.setFixedSize(440, 700)

        self.localized_highlights = {'en': [], 'ar': [], 'ku': []}
        self.localized_team_msg   = {'en': '', 'ar': '', 'ku': ''}
        self.current_team_lang    = 'en'

        central = QWidget()
        self.setCentralWidget(central)
        layout = QVBoxLayout(central)
        layout.setSpacing(8)
        layout.setContentsMargins(20, 16, 20, 16)

        # Header
        header = QLabel("🚀 Release Helper")
        header.setFont(QFont("Segoe UI", 15, QFont.Bold))
        header.setAlignment(Qt.AlignCenter)
        layout.addWidget(header)

        # Version info
        try:
            current, current_min = read_version()
        except Exception:
            current, current_min = "1.0.0", "1.0.0"

        layout.addWidget(QLabel(f"Current Version: {current}   (Min: {current_min})"))

        # New version
        v_row = QHBoxLayout()
        v_row.addWidget(QLabel("New Version:"))
        self.version_edit = QLineEdit(increment_version(current))
        self.version_edit.textChanged.connect(self._update_commit_msg)
        v_row.addWidget(self.version_edit)
        layout.addLayout(v_row)

        # Min version
        m_row = QHBoxLayout()
        m_row.addWidget(QLabel("Min Version:"))
        self.min_version_edit = QLineEdit(current_min)
        m_row.addWidget(self.min_version_edit)
        layout.addLayout(m_row)

        # Commit message
        layout.addWidget(QLabel("Commit Message:"))
        self.msg_edit = QLineEdit(f"Release v{increment_version(current)}")
        layout.addWidget(self.msg_edit)

        # Release scope
        scope_box = QGroupBox("Changes to Include")
        scope_box.setMinimumHeight(76)
        scope_box.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Fixed)
        scope_layout = QVBoxLayout(scope_box)
        scope_layout.setContentsMargins(10, 8, 10, 8)
        self.release_scope_group = QButtonGroup(self)

        self.all_changes_rb = QRadioButton("All changes")
        self.all_changes_rb.setChecked(True)
        self.all_changes_rb.setToolTip(
            "Stage and release every changed and untracked file in the repository."
        )
        self.release_scope_group.addButton(self.all_changes_rb)
        scope_layout.addWidget(self.all_changes_rb)

        self.staged_changes_rb = QRadioButton("Staged changes only")
        self.staged_changes_rb.setToolTip(
            "Keep unrelated unstaged and untracked work out of the release commit. "
            "Release version and configuration files are staged automatically."
        )
        self.release_scope_group.addButton(self.staged_changes_rb)
        scope_layout.addWidget(self.staged_changes_rb)
        layout.addWidget(scope_box)

        # Highlights button
        self.highlights_btn = QPushButton("📝 Manage Highlights")
        self.highlights_btn.clicked.connect(self.manage_highlights)
        layout.addWidget(self.highlights_btn)

        self.highlights_label = QLabel("0 highlights (EN: 0, AR: 0, KU: 0)")
        self.highlights_label.setStyleSheet("color: gray;")
        layout.addWidget(self.highlights_label)

        # Stealth
        self.stealth_cb = QCheckBox("🤫 Stealth Update (Skip Patch Notes)")
        self.stealth_cb.setChecked(True)
        self.stealth_cb.toggled.connect(self.toggle_stealth)
        layout.addWidget(self.stealth_cb)

        # Skip latest.json (no auto-update for users)
        self.skip_latest_cb = QCheckBox("🚫 Skip Auto-Update (Don't replace latest.json in R2)")
        self.skip_latest_cb.setToolTip(
            "When checked, the release will NOT upload latest.json to R2.\n"
            "Existing users will NOT be prompted to update to this version."
        )
        self.skip_latest_cb.toggled.connect(self.toggle_skip_latest)
        layout.addWidget(self.skip_latest_cb)

        # Team message
        self.team_msg_cb = QCheckBox("Include Team Message?")
        self.team_msg_cb.toggled.connect(self.toggle_team_msg)
        layout.addWidget(self.team_msg_cb)

        # Team message language selector
        lang_row = QHBoxLayout()
        self.team_lang_group = QButtonGroup(self)
        for i, lang in enumerate(['en', 'ar', 'ku']):
            rb = QRadioButton(lang.upper())
            rb.setChecked(lang == 'en')
            rb.toggled.connect(self.switch_team_msg_lang)
            self.team_lang_group.addButton(rb, i)
            lang_row.addWidget(rb)
        lang_row.addStretch()
        layout.addLayout(lang_row)

        self.team_msg_edit = QTextEdit()
        self.team_msg_edit.setFixedHeight(70)
        self.team_msg_edit.setEnabled(False)
        layout.addWidget(self.team_msg_edit)

        # Separator
        sep = QFrame()
        sep.setFrameShape(QFrame.HLine)
        sep.setStyleSheet("color: #ccc;")
        layout.addWidget(sep)

        # Buttons
        btn_row = QHBoxLayout()
        release_btn = QPushButton("🚀 Release")
        release_btn.clicked.connect(self.release)
        cancel_btn = QPushButton("❌ Cancel")
        cancel_btn.clicked.connect(self.close)
        btn_row.addWidget(release_btn)
        btn_row.addWidget(cancel_btn)
        layout.addLayout(btn_row)

        self.status_label = QLabel("Ready")
        self.status_label.setStyleSheet("color: gray;")
        self.status_label.setAlignment(Qt.AlignCenter)
        layout.addWidget(self.status_label)

        # Local build section
        sep2 = QFrame()
        sep2.setFrameShape(QFrame.HLine)
        sep2.setStyleSheet("color: #ccc;")
        layout.addWidget(sep2)

        local_lbl = QLabel("Local Development Tools")
        local_lbl.setFont(QFont("Segoe UI", 9, QFont.Bold))
        layout.addWidget(local_lbl)

        build_btn = QPushButton("🛠️ Build Local APK")
        build_btn.clicked.connect(self.build_apk_local_cmd)
        layout.addWidget(build_btn)

        hint = QLabel("(Use this only to test the APK on your phone manually)")
        hint.setStyleSheet("color: #666; font-style: italic; font-size: 8pt;")
        layout.addWidget(hint)

    # ── Slots ──────────────────────────────────────────────────────────────────
    def _update_commit_msg(self, text):
        self.msg_edit.setText(f"Release v{text}")

    def current_team_lang_str(self):
        idx = self.team_lang_group.checkedId()
        return ['en', 'ar', 'ku'][idx]

    def switch_team_msg_lang(self):
        # Save current text before switching
        self.localized_team_msg[self.current_team_lang] = self.team_msg_edit.toPlainText().strip()

        new_lang = self.current_team_lang_str()
        self.current_team_lang = new_lang

        apply_rtl(self.team_msg_edit, new_lang)
        self.team_msg_edit.setPlainText(self.localized_team_msg[new_lang])

    def toggle_team_msg(self, checked):
        self.team_msg_edit.setEnabled(checked)
        if checked:
            self.team_msg_edit.setFocus()
        else:
            self.localized_team_msg[self.current_team_lang] = self.team_msg_edit.toPlainText().strip()
            self.team_msg_edit.clear()

    def toggle_stealth(self, checked):
        self.highlights_btn.setEnabled(not checked)
        self.team_msg_cb.setEnabled(not checked)
        self.status_label.setText("Stealth mode active" if checked else "Ready")

    def toggle_skip_latest(self, checked):
        self.min_version_edit.setEnabled(not checked)
        text = self.msg_edit.text()
        if checked and not text.endswith(" SAU"):
            self.msg_edit.setText(text + " SAU")
        elif not checked and text.endswith(" SAU"):
            self.msg_edit.setText(text[:-4])

    def manage_highlights(self):
        dlg = HighlightsDialog(self, self.localized_highlights)
        dlg.exec()
        counts = [f"{l.upper()}: {len(self.localized_highlights[l])}" for l in ['en', 'ar', 'ku']]
        total = sum(len(v) for v in self.localized_highlights.values())
        self.highlights_label.setText(f"{total} highlights ({', '.join(counts)})")

    def build_apk(self):
        try:
            self.status_label.setText("Building Local Android APK...")
            QApplication.processEvents()

            subprocess.run(['npm.cmd', 'run', 'android:build'], cwd=SCRIPT_DIR, check=True, shell=True)

            potential_paths = [
                SCRIPT_DIR / "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk",
                SCRIPT_DIR / "src-tauri/gen/android/app/build/outputs/apk/release/app-release-unsigned.apk",
                SCRIPT_DIR / "src-tauri/gen/android/app/build/outputs/apk/debug/app-debug.apk",
            ]
            apk_path = next((p for p in potential_paths if p.exists()), None)
            output_apk = SCRIPT_DIR / "Asaas.apk"

            if apk_path:
                import shutil
                shutil.copy2(apk_path, output_apk)
                self.status_label.setText("Ready")
                return True, "APK built and renamed to Asaas.apk"
            else:
                self.status_label.setText("Failed")
                return False, "APK not found after build"
        except subprocess.CalledProcessError as e:
            self.status_label.setText("Failed")
            return False, f"Build error: {e}"
        except Exception as e:
            self.status_label.setText("Failed")
            return False, f"Unexpected error: {e}"

    def build_apk_local_cmd(self):
        reply = QMessageBox.question(
            self, "Confirm Local Build",
            "This will build the APK on your computer (takes a few minutes).\n\n"
            "Note: GitHub already builds this automatically during release.\n\nContinue?",
            QMessageBox.Yes | QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return
        success, message = self.build_apk()
        if success:
            QMessageBox.information(self, "Success", message)
        else:
            QMessageBox.critical(self, "Error", message)
        self.status_label.setText("Ready")

    def release(self):
        version = self.version_edit.text().strip().lstrip('vV')
        msg = self.msg_edit.text().strip()
        staged_only = self.staged_changes_rb.isChecked()

        if not version or not msg:
            QMessageBox.critical(self, "Error", "Version and message are required!")
            return

        if staged_only:
            managed_files_with_unstaged_work = unstaged_release_managed_files()
            if managed_files_with_unstaged_work:
                QMessageBox.critical(
                    self, "Unstaged Release Metadata",
                    "Staged-only releases cannot safely continue because these release "
                    "metadata files have unstaged or untracked changes:\n\n"
                    f"{chr(10).join(managed_files_with_unstaged_work)}\n\n"
                    "Stage or discard those changes first, then try again."
                )
                return
            if not has_staged_changes():
                QMessageBox.critical(
                    self, "No Staged Changes",
                    "Stage the changes you want to release before choosing "
                    "'Staged changes only'."
                )
                return
        elif not is_git_clean():
            reply = QMessageBox.question(
                self, "Uncommitted Changes",
                "You have uncommitted changes in your repository.\n\n"
                "These will be included in the release commit automatically.\nContinue?",
                QMessageBox.Yes | QMessageBox.No
            )
            if reply != QMessageBox.Yes:
                return

        steps = "\n".join([
            f"1. Update version to {version}",
            (
                f"2. Commit staged changes and release metadata: {msg}"
                if staged_only else f"2. Commit all changes: {msg}"
            ),
            f"3. Create tag v{version}",
            f"4. Push to GitHub (Triggers Auto-Releases)",
        ])
        reply = QMessageBox.question(
            self, "Confirm Release",
            f"This will start the GitHub release process:\n\n{steps}\n\nContinue?",
            QMessageBox.Yes | QMessageBox.No
        )
        if reply != QMessageBox.Yes:
            return

        self.status_label.setText("Updating version...")
        QApplication.processEvents()

        try:
            update_version(version, self.min_version_edit.text().strip())

            # Write release config for CI to read
            release_config = {"skip_latest_json": self.skip_latest_cb.isChecked()}
            with open(RELEASE_CONFIG, 'w') as f:
                json.dump(release_config, f, indent=2)

            if not self.stealth_cb.isChecked():
                self.localized_team_msg[self.current_team_lang] = self.team_msg_edit.toPlainText().strip()
                team_messages = {l: self.localized_team_msg[l] for l in ['en', 'ar', 'ku'] if self.localized_team_msg[l]}
                update_patch_notes(version, self.localized_highlights, team_messages)
            else:
                print("Skipping patch notes (Stealth mode)")

            self.status_label.setText("Optimizing tip videos...")
            QApplication.processEvents()
            optimize_tip_videos()

            self.status_label.setText("Pushing to GitHub...")
            QApplication.processEvents()

            if staged_only:
                stage_release_metadata()

            success, message = run_git_commands(
                version, msg, stage_all_changes=not staged_only
            )
            if success:
                QMessageBox.information(
                    self, "Success",
                    message + "\n\nGitHub will now build both Windows and Android versions automatically!"
                )
                self.close()
            else:
                QMessageBox.critical(self, "Error", message)
                self.status_label.setText("Failed")
        except Exception as e:
            QMessageBox.critical(self, "Error", str(e))
            self.status_label.setText("Failed")


# ── Entry point ────────────────────────────────────────────────────────────────
# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setStyle("Fusion")

    # Force light mode regardless of system theme
    from PySide6.QtGui import QPalette, QColor
    palette = QPalette()
    palette.setColor(QPalette.Window,          QColor(240, 240, 240))
    palette.setColor(QPalette.WindowText,      QColor(0, 0, 0))
    palette.setColor(QPalette.Base,            QColor(255, 255, 255))
    palette.setColor(QPalette.AlternateBase,   QColor(233, 233, 233))
    palette.setColor(QPalette.ToolTipBase,     QColor(255, 255, 220))
    palette.setColor(QPalette.ToolTipText,     QColor(0, 0, 0))
    palette.setColor(QPalette.Text,            QColor(0, 0, 0))
    palette.setColor(QPalette.Button,          QColor(240, 240, 240))
    palette.setColor(QPalette.ButtonText,      QColor(0, 0, 0))
    palette.setColor(QPalette.BrightText,      QColor(255, 0, 0))
    palette.setColor(QPalette.Link,            QColor(0, 0, 255))
    palette.setColor(QPalette.Highlight,       QColor(0, 120, 215))
    palette.setColor(QPalette.HighlightedText, QColor(255, 255, 255))
    app.setPalette(palette)

    window = ReleaseApp()
    window.show()
    sys.exit(app.exec())
