<!-- Notes for the next GitHub release (Desktop builds workflow). {{VERSION}} becomes the version in package.json; checksums are added automatically. -->
## Which file do I download?

Scroll down to **Assets** below and click the one file for your computer:

| Your computer | Download this |
| --- | --- |
| **Mac** (Apple silicon or Intel) | **Classic-Image-Editor_{{VERSION}}_macOS-universal.dmg** |
| **Windows** 10/11 | **Classic-Image-Editor_{{VERSION}}_x64-setup.exe** |
| **Linux** | **Classic-Image-Editor_{{VERSION}}_amd64.AppImage** (or the .deb / .rpm) |

Ignore the "Source code" files; those aren't the app.

**First time installing an app from GitHub?** Follow the step-by-step guide: **[How to install Classic Image Editor](https://github.com/mjonrdgcms/classic-image-editor/blob/main/INSTALL.md)**. On a Mac, the first time you open the app you'll need to allow it once in **System Settings → Privacy & Security → Open Anyway** ([Mac steps](https://github.com/mjonrdgcms/classic-image-editor/blob/main/INSTALL.md#mac)).

---

Classic Image Editor is a fast, offline desktop image editor in the spirit of the classic Photoshop 7 workflow. Free and open source (MIT).

**New in 0.13.0:**
- **Nudge with the arrow keys:** Ctrl+arrows nudge the layer 1 pixel with any tool (add Shift for 10), the Move tool's arrows do the same, and with a selection tool the arrows move the selection outline. A run of nudges is one History step, and pixels nudged across other pixels and back come out intact.
- **Right-click a layer** for Merge Up, Merge Down (Merge Layers with several selected), Merge Visible, Flatten Image, and the other layer commands.
- **Alt picks colors with the Brush** (and the Pencil, Paint Bucket and Gradient) every time: it used to stop working after you changed a setting on the options bar. Hold Alt and click or drag over the image; the cursor turns into an eyedropper.
- **New images start at 4K** (3840 x 2160).

### Windows 10/11 (64-bit)
- **Classic-Image-Editor_{{VERSION}}_x64-setup.exe**: installer (recommended). Adds Start menu shortcuts and an uninstaller.
- **Classic-Image-Editor_{{VERSION}}_x64-portable.exe**: standalone app, no install. Just run it.

Requires Microsoft Edge WebView2, which comes preinstalled on Windows 10/11.

> Not code-signed, so Windows SmartScreen may show "Windows protected your PC". Click **More info → Run anyway**.

### macOS 11 Big Sur or later (Apple silicon and Intel)
- **Classic-Image-Editor_{{VERSION}}_macOS-universal.dmg**: open it and drag the app to Applications.
- **Classic-Image-Editor_{{VERSION}}_macOS-universal.app.zip**: the same app as a zip.

> Not notarized by Apple yet, so macOS blocks it the first time. **macOS 15 Sequoia or newer:** double-click the app, click **Done**, then go to System Settings → Privacy & Security, scroll down, click **Open Anyway** and enter your password. **macOS 14 or older:** right-click the app, choose **Open**, then **Open**. If it says the app "is damaged", run `xattr -cr "/Applications/Classic Image Editor.app"` in Terminal. [Full Mac steps](https://github.com/mjonrdgcms/classic-image-editor/blob/main/INSTALL.md#mac). On a Mac, Command does what Ctrl does in the docs, and Option is Alt.

### Linux (64-bit: Ubuntu 22.04+, Debian 12+, Fedora 36+ or similar)
- **Classic-Image-Editor_{{VERSION}}_amd64.deb**: Ubuntu, Debian, Mint: `sudo apt install ./Classic-Image-Editor_{{VERSION}}_amd64.deb`
- **Classic-Image-Editor-{{VERSION}}-1.x86_64.rpm**: Fedora, openSUSE, RHEL: `sudo dnf install ./Classic-Image-Editor-{{VERSION}}-1.x86_64.rpm`
- **Classic-Image-Editor_{{VERSION}}_amd64.AppImage**: any distribution, no install. `chmod +x` it and run it.
