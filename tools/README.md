# Atlas backup decoder

Run the offline GUI with:

```powershell
python tools\atlas_backup_decoder.py
```

Select the encrypted `.dump.age` backup, the private age key created for Atlas backups, and an output `.dump` location. The tool uses the locally installed `age.exe`; it does not send any file or key over the network.

The decrypted `.dump` contains sensitive database content. Keep it in a secure local folder and remove it when inspection or restoration is complete.
