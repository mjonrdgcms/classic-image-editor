# How to install Classic Image Editor

New to downloading apps from GitHub? No problem. This page walks you through it step by step. It takes about 2 minutes.

**Download page:** https://github.com/mjonrdgcms/classic-image-editor/releases/latest

Jump to: [Mac](#mac) · [Windows](#windows) · [Linux](#linux) · [Problems?](#something-went-wrong)

---

## Step 1: Download the right file

1. Open the download page: https://github.com/mjonrdgcms/classic-image-editor/releases/latest
2. Scroll down to the section called **Assets** (near the bottom, under the list of what's new). If you only see a couple of files, click **Show all assets**.
3. Click the **one** file for your computer:

| Your computer | Click the file that ends in | Example |
| --- | --- | --- |
| **Mac** (any Mac from the last few years, M1/M2/M3/M4 or Intel) | **`.dmg`** | `Classic-Image-Editor_0.13.0_macOS-universal.dmg` |
| **Windows** 10 or 11 | **`-setup.exe`** | `Classic-Image-Editor_0.13.0_x64-setup.exe` |
| **Linux** | **`.AppImage`** (works everywhere), or `.deb` (Ubuntu/Debian/Mint), or `.rpm` (Fedora/openSUSE) | `Classic-Image-Editor_0.13.0_amd64.AppImage` |

> **Ignore "Source code (zip)" and "Source code (tar.gz)".** Those are the app's programming code, not the app itself.

The file goes into your **Downloads** folder. Then follow the steps for your computer below.

---

## Mac

Works on macOS 11 Big Sur or later, on both Apple silicon (M1, M2, M3, M4…) and Intel Macs. It's the same file for both.

### Install it

1. Open your **Downloads** folder and double-click **`Classic-Image-Editor_…_macOS-universal.dmg`**.
2. A window opens showing the **Classic Image Editor** icon and an **Applications** folder. **Drag the Classic Image Editor icon onto the Applications folder.** Wait a few seconds for it to copy.
3. Close that window. Then "eject" the installer: in a Finder window's sidebar, click the **⏏** button next to **Classic Image Editor** (or right-click its icon on the desktop and choose **Eject**). You can now delete the `.dmg` file from Downloads.

### Open it the first time (important)

Classic Image Editor is a free app made by an independent developer and isn't registered with Apple, so **the very first time** you open it, your Mac will block it to be safe. You only have to allow it once. Which steps you follow depends on your macOS version (to check, click the Apple menu  > **About This Mac**).

**macOS 15 Sequoia, macOS 26 Tahoe, or newer:**

1. Open the **Applications** folder and double-click **Classic Image Editor**.
2. A message says *"Classic Image Editor" Not Opened* (or *Apple could not verify "Classic Image Editor" is free of malware…*). Click **Done**. (Don't click "Move to Trash".)
3. Click the Apple menu  > **System Settings** > **Privacy & Security** (in the left sidebar).
4. **Scroll all the way down** to the **Security** section. You'll see *"Classic Image Editor" was blocked to protect your Mac.* Click **Open Anyway**.
   (This button only shows up for about an hour after step 2. If it's not there, do step 1 again.)
5. Click **Open Anyway** again in the pop-up, then type your Mac's login password (the one you use to unlock your Mac) and click **OK**.

The app opens. From now on, it opens normally like any other app.

**macOS 14 Sonoma or older (Ventura, Monterey, Big Sur):**

1. Open the **Applications** folder.
2. **Right-click** (or hold **Control** and click) **Classic Image Editor** and choose **Open**.
3. In the warning, click **Open**.

That's it. From now on, it opens normally. (If there's no Open button, use the System Settings steps above; they work on every version.)

### If the Mac says the app "is damaged and can't be opened"

The app isn't really damaged. This message just means macOS is being extra cautious with an app downloaded from the internet. To fix it:

1. Make sure the app is in your **Applications** folder (see "Install it" above).
2. Open **Terminal** (press **⌘ Command + Space**, type `Terminal`, press **Return**).
3. Copy this line, paste it into Terminal, and press **Return**:

   ```
   xattr -cr "/Applications/Classic Image Editor.app"
   ```

   Nothing will appear to happen. That's normal.
4. Close Terminal and open Classic Image Editor from the Applications folder again. If you still get the "not opened" message, follow the "Open it the first time" steps above.

**Mac tip:** wherever the help says **Ctrl**, use **⌘ Command** on a Mac, and **Option** is **Alt**.

---

## Windows

Works on Windows 10 and 11 (64-bit).

1. Double-click **`Classic-Image-Editor_…_x64-setup.exe`** in your Downloads folder.
   - If your browser warns that the file *"isn't commonly downloaded"*, click the **…** (or the arrow) next to the download and choose **Keep** > **Keep anyway**.
2. A blue box may say **"Windows protected your PC"**. That just means the app isn't signed with a paid Microsoft certificate, not that something is wrong. Click **More info**, then **Run anyway**.
3. Follow the installer (click **Next** / **Install**). When it's done, open **Classic Image Editor** from the Start menu.

**Don't want to install anything?** Download the **`_x64-portable.exe`** file instead and just double-click it to run the app. You may see the same "Windows protected your PC" box; click **More info** > **Run anyway**.

The app uses Microsoft Edge WebView2, which is already built into Windows 10 and 11. If Windows says it's missing, the installer will get it for you, or download it from https://developer.microsoft.com/microsoft-edge/webview2/

---

## Linux

Works on 64-bit Ubuntu 22.04+, Debian 12+, Fedora 36+, and similar.

**AppImage (any distribution, no install):**

1. Right-click the **`.AppImage`** file > **Properties** > **Permissions**, and turn on **Allow executing file as program** (or "Executable as Program").
   Or in a terminal: `chmod +x Classic-Image-Editor_*_amd64.AppImage`
2. Double-click it to run.
3. If nothing happens on Ubuntu, install FUSE: `sudo apt install libfuse2` (on Ubuntu 24.04 and newer: `sudo apt install libfuse2t64`).

**Ubuntu, Debian, Mint (`.deb`):** open a terminal in your Downloads folder and run

```
sudo apt install ./Classic-Image-Editor_*_amd64.deb
```

**Fedora, openSUSE, RHEL (`.rpm`):** open a terminal in your Downloads folder and run

```
sudo dnf install ./Classic-Image-Editor-*-1.x86_64.rpm
```

(On openSUSE use `sudo zypper install ./Classic-Image-Editor-*-1.x86_64.rpm`.) Then open Classic Image Editor from your apps menu.

---

## Updating

Download the newest file from the same link, https://github.com/mjonrdgcms/classic-image-editor/releases/latest, and install it the same way. On a Mac, when you drag it to Applications, choose **Replace**. (You may need to do the one-time "Open Anyway" step again after an update.)

## Something went wrong?

- **Can't find the download?** It's under **Assets** at the bottom of the release page, not the green "Code" button.
- **Downloaded a "Source code" zip by mistake?** Delete it and pick the file for your computer from the table above.
- **Still stuck?** [Open an issue](https://github.com/mjonrdgcms/classic-image-editor/issues) and say which computer and which step you're on.

## Sharing the app with a friend

Send them this link. It always goes to the newest version:

**https://github.com/mjonrdgcms/classic-image-editor/releases/latest**

and this guide: https://github.com/mjonrdgcms/classic-image-editor/blob/main/INSTALL.md
