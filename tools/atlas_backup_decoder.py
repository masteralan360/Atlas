"""Offline GUI for decrypting Atlas Supabase backup archives.

Run from PowerShell with:
    python tools\atlas_backup_decoder.py

The utility calls the locally installed age executable. It never uploads the
backup or private key, and it does not retain either path after the app closes.
"""

from __future__ import annotations

import os
import queue
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Literal

import tkinter as tk
from tkinter import filedialog, messagebox, ttk


APP_TITLE = "Atlas Backup Decoder"
EventKind = Literal["success", "error"]


class AtlasBackupDecoder:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title(APP_TITLE)
        self.root.minsize(720, 330)
        self.root.columnconfigure(1, weight=1)

        self.encrypted_path = tk.StringVar()
        self.identity_path = tk.StringVar()
        self.output_path = tk.StringVar()
        self.age_path = tk.StringVar(value=shutil.which("age") or shutil.which("age.exe") or "")
        self.status = tk.StringVar(value="Select an encrypted backup and your private age key.")
        self.events: queue.Queue[tuple[EventKind, str]] = queue.Queue()

        self._build()
        self.root.after(100, self._handle_events)

    def _build(self) -> None:
        padding = {"padx": 12, "pady": 6}

        heading = ttk.Label(
            self.root,
            text="Decrypt an Atlas database backup",
            font=("Segoe UI", 14, "bold"),
        )
        heading.grid(row=0, column=0, columnspan=3, sticky="w", **padding)

        note = ttk.Label(
            self.root,
            text=(
                "Everything stays on this computer. The output is a plaintext PostgreSQL "
                "archive, so store it securely and remove it after inspection or restore."
            ),
            wraplength=680,
        )
        note.grid(row=1, column=0, columnspan=3, sticky="w", **padding)

        self._file_row(
            row=2,
            label="Encrypted backup (.dump.age) *",
            variable=self.encrypted_path,
            choose=self._choose_encrypted_backup,
            filetypes=[("Encrypted Atlas backup", "*.dump.age"), ("Age encrypted file", "*.age"), ("All files", "*.*")],
        )
        self._file_row(
            row=3,
            label="Private age key *",
            variable=self.identity_path,
            choose=self._choose_identity,
            filetypes=[("Age identity file", "*.txt"), ("All files", "*.*")],
        )
        self._file_row(
            row=4,
            label="Decrypted archive (.dump) *",
            variable=self.output_path,
            choose=self._choose_output,
            filetypes=[("PostgreSQL archive", "*.dump"), ("All files", "*.*")],
            save=True,
        )
        self._file_row(
            row=5,
            label="age executable",
            variable=self.age_path,
            choose=self._choose_age_executable,
            filetypes=[("age executable", "age.exe"), ("Executables", "*.exe"), ("All files", "*.*")],
        )

        self.decrypt_button = ttk.Button(self.root, text="Decrypt backup", command=self._decrypt)
        self.decrypt_button.grid(row=6, column=1, sticky="e", padx=12, pady=(16, 6))
        ttk.Button(self.root, text="Open output folder", command=self._open_output_folder).grid(
            row=6, column=2, sticky="e", padx=12, pady=(16, 6)
        )

        ttk.Separator(self.root).grid(row=7, column=0, columnspan=3, sticky="ew", padx=12, pady=(6, 0))
        ttk.Label(self.root, textvariable=self.status, wraplength=680).grid(
            row=8, column=0, columnspan=3, sticky="w", **padding
        )

    def _file_row(
        self,
        *,
        row: int,
        label: str,
        variable: tk.StringVar,
        choose: callable,
        filetypes: list[tuple[str, str]],
        save: bool = False,
    ) -> None:
        ttk.Label(self.root, text=label).grid(row=row, column=0, sticky="w", padx=12, pady=6)
        ttk.Entry(self.root, textvariable=variable).grid(row=row, column=1, sticky="ew", padx=(0, 8), pady=6)
        ttk.Button(self.root, text="Choose…", command=lambda: choose(filetypes, save)).grid(
            row=row, column=2, sticky="e", padx=12, pady=6
        )

    def _choose_encrypted_backup(self, filetypes: list[tuple[str, str]], _: bool) -> None:
        selected = filedialog.askopenfilename(title="Select encrypted backup", filetypes=filetypes)
        if not selected:
            return
        self.encrypted_path.set(selected)
        source = Path(selected)
        self.output_path.set(str(source.with_suffix("")) if source.suffix.lower() == ".age" else f"{selected}.dump")

    def _choose_identity(self, filetypes: list[tuple[str, str]], _: bool) -> None:
        selected = filedialog.askopenfilename(title="Select private age key", filetypes=filetypes)
        if selected:
            self.identity_path.set(selected)

    def _choose_output(self, filetypes: list[tuple[str, str]], _: bool) -> None:
        selected = filedialog.asksaveasfilename(
            title="Choose decrypted archive location",
            defaultextension=".dump",
            filetypes=filetypes,
        )
        if selected:
            self.output_path.set(selected)

    def _choose_age_executable(self, filetypes: list[tuple[str, str]], _: bool) -> None:
        selected = filedialog.askopenfilename(title="Select age.exe", filetypes=filetypes)
        if selected:
            self.age_path.set(selected)

    def _decrypt(self) -> None:
        source_text = self.encrypted_path.get().strip()
        identity_text = self.identity_path.get().strip()
        output_text = self.output_path.get().strip()
        age_text = self.age_path.get().strip()
        if not all((source_text, identity_text, output_text, age_text)):
            self._show_error("Select the encrypted backup, private key, output file, and age executable.")
            return

        source = Path(source_text).expanduser()
        identity = Path(identity_text).expanduser()
        output = Path(output_text).expanduser()
        age_executable = Path(age_text).expanduser()
        if not source.is_file():
            self._show_error("The encrypted backup file was not found.")
            return
        if not identity.is_file():
            self._show_error("The private age key file was not found.")
            return
        if not age_executable.is_file():
            self._show_error("age.exe was not found. Install age or choose its executable.")
            return
        if not output.parent.is_dir():
            self._show_error("Choose an output folder that already exists.")
            return
        if source.resolve() == output.resolve() or identity.resolve() == output.resolve():
            self._show_error("The decrypted archive must use a different path from the backup and private key.")
            return
        if output.exists() and not messagebox.askyesno(
            APP_TITLE,
            f"{output.name} already exists. Replace it after successful decryption?",
            parent=self.root,
        ):
            return

        self.decrypt_button.configure(state="disabled")
        self.status.set("Decrypting locally…")
        threading.Thread(
            target=self._decrypt_worker,
            args=(source, identity, output, age_executable),
            daemon=True,
        ).start()

    def _decrypt_worker(self, source: Path, identity: Path, output: Path, age_executable: Path) -> None:
        temporary_output = output.with_name(f".{output.name}.{uuid.uuid4().hex}.tmp")
        try:
            result = subprocess.run(
                [
                    str(age_executable),
                    "--decrypt",
                    "--identity",
                    str(identity),
                    "--output",
                    str(temporary_output),
                    str(source),
                ],
                check=False,
                capture_output=True,
                text=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if result.returncode != 0:
                details = result.stderr.strip() or "age could not decrypt this backup. Check that the private key is correct."
                self.events.put(("error", details))
                return
            if not temporary_output.is_file() or temporary_output.stat().st_size == 0:
                self.events.put(("error", "age completed without creating a decrypted archive."))
                return
            os.replace(temporary_output, output)
            self.events.put(("success", str(output)))
        except OSError as error:
            self.events.put(("error", f"Could not run age: {error}"))
        finally:
            if temporary_output.exists():
                temporary_output.unlink(missing_ok=True)

    def _handle_events(self) -> None:
        try:
            while True:
                event, payload = self.events.get_nowait()
                self.decrypt_button.configure(state="normal")
                if event == "success":
                    self.status.set(f"Decryption complete: {payload}")
                    messagebox.showinfo(
                        APP_TITLE,
                        "Backup decrypted successfully. Use pg_restore --list on the .dump file to inspect its contents.",
                        parent=self.root,
                    )
                else:
                    self.status.set("Decryption failed.")
                    self._show_error(payload)
        except queue.Empty:
            pass
        self.root.after(100, self._handle_events)

    def _open_output_folder(self) -> None:
        output_text = self.output_path.get().strip()
        folder = Path(output_text).expanduser().parent if output_text else Path.home()
        if not folder.is_dir():
            self._show_error("Choose an existing output folder first.")
            return
        os.startfile(folder)  # type: ignore[attr-defined]  # Windows-only utility.

    def _show_error(self, message: str) -> None:
        messagebox.showerror(APP_TITLE, message, parent=self.root)


def main() -> None:
    root = tk.Tk()
    AtlasBackupDecoder(root)
    root.mainloop()


if __name__ == "__main__":
    main()
