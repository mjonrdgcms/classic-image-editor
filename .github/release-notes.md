<!-- Notes for the next GitHub release (Desktop builds workflow). {{VERSION}} becomes the version in package.json; checksums are added automatically. -->
Classic Image Editor is a fast, offline desktop image editor in the spirit of the classic Photoshop 7 workflow. Free and open source (MIT).

**New in 0.12.0: macOS and Linux apps**, alongside Windows. Also includes everything from 0.11.0: the Move tool's Auto-Select (off by default, so the Move tool moves the layer you picked), Photoshop 7's keyboard shortcuts and temporary tools (hold Alt for the Eyedropper, Ctrl for Move, Space for Hand), a full Preferences dialog, scratch disks you can choose, and crash recovery. Quitting now asks before discarding unsaved images.

### Windows 10/11 (64-bit)
- **Classic-Image-Editor_{{VERSION}}_x64-setup.exe**: installer (recommended). Adds Start menu shortcuts and an uninstaller.
- **Classic-Image-Editor_{{VERSION}}_x64-portable.exe**: standalone app, no install. Just run it.

Requires Microsoft Edge WebView2, which comes preinstalled on Windows 10/11.

> Not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**.

### macOS 11 Big Sur or later (Apple silicon and Intel)
- **Classic-Image-Editor_{{VERSION}}_macOS-universal.dmg**: open it and drag the app to Applications.
- **Classic-Image-Editor_{{VERSION}}_macOS-universal.app.zip**: the same app as a zip.

> Not notarized by Apple yet. The first time, right-click the app and choose **Open**, then **Open** again (or allow it under System Settings → Privacy & Security). On a Mac, Command does what Ctrl does in the docs, and Option is Alt.

### Linux (64-bit: Ubuntu 22.04+, Debian 12+, Fedora 36+ or similar)
- **Classic-Image-Editor_{{VERSION}}_amd64.deb**: Ubuntu, Debian, Mint: `sudo apt install ./Classic-Image-Editor_{{VERSION}}_amd64.deb`
- **Classic-Image-Editor-{{VERSION}}-1.x86_64.rpm**: Fedora, openSUSE, RHEL: `sudo dnf install ./Classic-Image-Editor-{{VERSION}}-1.x86_64.rpm`
- **Classic-Image-Editor_{{VERSION}}_amd64.AppImage**: any distribution, no install. `chmod +x` it and run it.
