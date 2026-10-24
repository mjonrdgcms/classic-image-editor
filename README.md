# Classic Image Editor

A fast, offline desktop image editor in the spirit of the classic Photoshop 7
workflow, with a local AI assistant (via Ollama) on the roadmap.

**Current version: 0.12.0** (core editing, filters, Black & White Lab, Actions, layer masks, type with 115 bundled fonts, Liquify, AI people selection, Face Swap, layered .cie files, Free Transform, Levels & Curves, retouching tools, Content-Aware Fill, layer styles, several layers at once, shapes and paths, the full PS7 toolbox, Photoshop's keyboard shortcuts, a full Preferences dialog, scratch disks and crash recovery, and now apps for macOS and Linux as well as Windows).

## Download

| System | Files | Notes |
| --- | --- | --- |
| Windows 10/11 | `Classic Image Editor X Setup.exe`, or the portable `.exe` | |
| macOS 11 Big Sur or later (Apple silicon and Intel) | `Classic Image Editor X (macOS).dmg` | Open the disk image and drag the app to Applications. The app isn't notarized by Apple yet, so the first time, right-click it and choose **Open** (or allow it under System Settings > Privacy & Security). |
| Ubuntu, Debian, Mint | `Classic Image Editor_X_amd64.deb` | `sudo apt install ./Classic*.deb` |
| Fedora, openSUSE, RHEL | `Classic Image Editor-X-1.x86_64.rpm` | `sudo dnf install ./Classic*.rpm` |
| Any 64-bit Linux | `Classic Image Editor_X_amd64.AppImage` | `chmod +x` it and run it; no install needed. |

The macOS and Linux apps are built by `.github/workflows/desktop.yml`
(Actions tab: download them from a run's artifacts). They draw with WebKit
(Safari's engine) instead of Windows' WebView2, and the end-to-end suite
runs in both engines.

On a Mac, the Command key does everything Ctrl does in this README
(Cmd+Z, Cmd-click on a thumbnail, holding Cmd for the Move tool), and Option
is Alt. On Linux the scratch disk defaults to `/tmp`; pick a roomier folder
in Preferences > Memory & Scratch Disks for big images.

## Run it

### Prerequisites

- **Node.js 20+** (https://nodejs.org)
- **Rust** via rustup (https://rustup.rs)
- Platform libraries for Tauri:
  - **Windows:** Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (preinstalled on Windows 10/11).
  - **macOS:** Xcode Command Line Tools: `xcode-select --install`
  - **Linux (Debian/Ubuntu):**
    `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

Full details: https://v2.tauri.app/start/prerequisites/

### Desktop app

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build an installer into src-tauri/target/release/bundle/
```

### Quick look in a browser (no Rust needed)

```bash
npm install
npm run dev            # then open http://localhost:1420
```

The browser version uses a file picker and downloads instead of native
dialogs, and a few Ctrl shortcuts (Ctrl+N, Ctrl+W) are reserved by the
browser. The desktop app receives them all.

## What works

| Area | Included |
| --- | --- |
| Image windows | Every open image gets its own floating window (the default, as in PS7): drag by the title bar, resize from any edge, minimize, maximize, close. Click a window to make it active. Maximized mode shows the active image full size with a tab per image. Window > Arrange: Cascade, Tile, Floating / Maximized, Next / Previous Image (Ctrl+Tab / Ctrl+Shift+Tab). Close (Ctrl+W) and Close All (Ctrl+Alt+W) ask before discarding changes. Each image has its own undo history |
| Files | New (presets, white / background / transparent), Open PNG, JPEG, GIF, BMP, WebP, AVIF and .cie, drag-and-drop or paste to open, **Save / Save As (Ctrl+S / Ctrl+Shift+S) to a layered .cie file**, Open Recent, Revert (F12), Save a Copy as PNG or JPEG (PS7-style 0-12 quality); double-clicking a .cie file opens it in the editor (see Files below) |
| Image size | Image Size (Ctrl+Alt+I: pixels or percent, Document Size in inches / cm / mm / points / picas, Resolution, Resample Image on or off, constrain proportions, Bicubic / Bilinear / Lanczos / Nearest Neighbor), Canvas Size (Ctrl+Alt+C: anchor grid, relative), Rotate Canvas (180°, 90° CW / CCW, arbitrary, flip), Trim, Duplicate Image, Histogram |
| Transform | Free Transform (Ctrl+T) on a layer, several selected layers at once, selected pixels or the selection outline: scale (in proportion by default), rotate, skew, distort, perspective, flip, numeric entry, reference point (see Transform below) |
| Several layers | Ctrl-click layers to add or remove them, Shift-click to select a run; move, Free Transform, align, distribute, link, group into a set, duplicate, delete, merge, and change opacity, blend mode or visibility for all of them at once (see Several Layers below) |
| Shapes and paths | Pen, Freeform Pen, Add / Delete Anchor Point, Convert Point, Path Selection and Direct Selection; Rectangle, Rounded Rectangle, Ellipse, Polygon (and star), Line (with arrowheads) and Custom Shape tools making editable shape layers or work paths; Paths palette (see Shapes and Paths below) |
| Notes, slices, measuring | Notes tool, Slice and Slice Select tools with File > Export > Slices, Color Sampler (up to four readouts in the Info palette), Measure tool with Straighten |
| Retouching | Spot Healing Brush, Healing Brush, Patch, Red Eye, Clone Stamp, Pattern Stamp, History Brush, Art History Brush, Color Replacement, Dodge, Burn, Sponge, Blur, Sharpen, Smudge, Background Eraser, Magic Eraser, Content-Aware Fill (Shift+Backspace), Remove Background (see Retouching below) |
| Layer styles | Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel and Emboss, Color Overlay and Stroke, editable any time, with a Styles palette of ready-made looks (see Layer Styles below) |
| Selections | Select Subject and Select People (AI), Grow, Similar, Transform Selection, Rectangular, Elliptical, Single Row and Single Column Marquee (Normal, Fixed Aspect Ratio, Fixed Size), Lasso, Polygonal Lasso, Magnetic Lasso, Magic Wand (tolerance, contiguous, anti-alias, use all layers), Color Range, Select All / Deselect / Reselect / Inverse, Feather, Modify > Border / Smooth / Expand / Contract, new / add / subtract / intersect (buttons or Shift / Alt / Shift+Alt), drag inside a selection to move its outline, arrow-key nudge, soft-edged (anti-aliased, feathered) selections everywhere |
| Quick Mask | Q toggles; paint black to mask, white to select; red overlay; Fill, Clear and Invert work on it |
| Layers | New (dialog with mode, opacity, clipping), duplicate, delete, Layer via Copy / Cut, rename, show / hide (Alt-click: show only this), 22 blend modes, opacity, Background rules, Merge Down, Merge Visible, Flatten |
| Layer sets | New Set, New Set From Linked, drag layers in and out, Pass Through or any blend mode, set opacity, collapse / expand, merge a set, delete set only or with contents |
| Layer masks | On layers and layer sets; paint, fill, gradient, filter, adjust, copy and paste on the mask; non-destructive Density and Feather; link / unlink; view the mask alone or as an overlay; Mask Edge refine (see Layer Masks below) |
| Liquify | Filter > Liquify (Ctrl+Shift+X): the full PS7 tool set, reconstruct modes, freeze masks, mesh and backdrop views, saved meshes, plus Face-Aware Liquify (see Liquify below) |
| Face Swap | Face Swap tool (J): brush the face to replace, brush the face to use (in any open image), click Swap; it follows the angle, expression and light of the original (see Face Swap below) |
| People | Select > Subject and Select > People...: on-device AI finds every person, tells touching people apart, and selects whole people or their hair, face, skin, clothes or accessories (see Selecting People below) |
| Type | Type tool (T): point and paragraph text, editable type layers, 115 bundled font families plus your installed fonts, Character and Paragraph palettes (see Type below) |
| Clipping | Group with Previous (Ctrl+G, or Alt-click a layer), Ungroup |
| Locks and links | Lock transparency, image pixels, position, all; link layers so they move together |
| Arrange | Bring to Front / Forward, Send Backward / to Back (Ctrl+[ ]), drag in the Layers palette, drag onto the trash or new-layer buttons |
| Painting | Brush, Pencil (Auto Erase), Eraser (Brush / Pencil / Block), Magic Eraser, Paint Bucket, Edit > Stroke (inside, center, outside), Gradient (linear, radial, angle, reflected, diamond; 10 presets, reverse, dither, transparency, blend modes; works on pixels, masks and Quick Mask). Paint modes (all blend modes plus Behind and Clear), opacity, flow, airbrush, pen pressure |
| Brushes palette | Presets (round, soft, sampled: spatter, chalk, star, dune grass), Define Brush from a selection, Brush Tip Shape (diameter, angle, roundness, hardness, spacing), Shape Dynamics, Scattering, Color Dynamics, Other Dynamics, Noise, Airbrush, live stroke preview, save / load brush sets |
| Tool Presets | Save a tool with its settings and brush; pick from the palette or the options bar's tool icon |
| Clipboard | Cut, Copy, Copy Merged, Paste, Paste Into; copies go to the system clipboard as PNG, and images copied in other programs paste in |
| Crop | Crop tool with handles, shield and Enter / Esc; Image > Crop to the selection; cropping past the edge extends the canvas |
| View | Rulers in pixels, inches, cm, mm, points, picas or percent (right-click to change), guides (drag from rulers, move with the Move tool, New Guide, Lock, Clear), grid (lines, dashed or dots, in any unit), pixel grid past 600%, snap to guides / grid / edges, Extras, three screen modes (F), zoom 1-1600% |
| Filters | 179 filters in 15 categories (see Filter Library below), Last Filter (Ctrl+F), Last Filter with Dialog (Ctrl+Alt+F), Fade (Ctrl+Shift+F) with opacity and blend mode |
| Adjustments | Levels (Ctrl+L), Curves (Ctrl+M), Color Balance (Ctrl+B), Photo Filter, Hue/Saturation (Ctrl+U), Brightness/Contrast, Exposure, Shadows/Highlights, Vibrance, White Balance, Channel Mixer, Gradient Map, Auto Levels, Auto Contrast, Auto Color (Ctrl+Shift+B), Equalize, Threshold, Posterize, Invert, Desaturate, and the Black & White Lab |
| Actions | Record, play, function keys, sets, step and dialog toggles, Button Mode, Batch |
| History | History palette, snapshots, Clear History, PS7's Ctrl+Z toggle (or multi-level undo with Ctrl+Shift+Z / Ctrl+Y), Edit > Purge |
| Memory | Scratch disks (up to four folders) for history that doesn't fit in memory, a memory limit, crash recovery copies (see Memory and Scratch Disks below) |
| Patterns | Edit > Define Pattern from a selection, Edit > Fill with a pattern, the Pattern Stamp, and a pattern picker with ready-made patterns |
| Preferences | Edit > Preferences (Ctrl+K) in nine sections, as in PS7: General, Tools, File Handling, Display & Cursors, Transparency, Units & Rulers, Guides Grid & Slices, Scratch Disks, Memory (see Preferences below) |
| Shortcuts | Photoshop 7's keyboard, including the temporary tools (Space, Ctrl, Alt, Ctrl+Space), number keys for opacity and flow, blend mode keys, layer stepping and the palette F-keys (see Keyboard below); every shortcut can be changed |

Every slot in the toolbox now holds a working tool. A few menu items from
later milestones still appear greyed out in their PS7 places, with a
tooltip saying when they are planned.

## Layer Masks

Masks work on layers **and on layer sets**. Black hides, white shows, grays
are partly transparent.

- **Add**: the mask button in the Layers palette, or Layer > Add Layer Mask:
  Reveal All, Hide All, Reveal / Hide Selection, or From Transparency.
- **Edit**: click the mask thumbnail (or Ctrl+\\) and every painting tool,
  Fill, the Gradient tool, filters, adjustments, Copy and Paste act on the
  mask. The colors turn gray while a mask is selected; D gives white over
  black. Ctrl+` goes back to the layer's pixels.
- **Look at it**: Alt-click the thumbnail to see the mask alone,
  Alt+Shift-click (or \\) for a colored overlay. Color and opacity are in
  Layer > Layer Mask > Layer Mask Display Options.
- **Thumbnail shortcuts**: Shift-click disables / enables; Ctrl-click loads
  it as a selection (add Shift to add, Alt to subtract, Shift+Alt to
  intersect); drag it onto the trash to Apply or Discard; drag it onto
  another layer or set to move it (Alt-drag copies). Ctrl-click a layer
  thumbnail selects its pixels.
- **Link**: the chain between the thumbnails. Unlinked masks stay put when
  the layer moves; with the Move tool, dragging while the unlinked mask is
  selected moves just the mask (arrows nudge it).
- **Masks palette** (Window > Masks): live **Density** (how strongly the
  mask hides; 100% as painted) and **Feather** (soft edge, in pixels), both
  non-destructive and undoable as one step; Mask Edge (smooth, feather,
  contrast and shift the edge, previewed live), Color Range into the mask,
  Invert, view buttons, load as selection, apply, disable, link and delete.
- Select > Load Selection loads a mask or a layer's transparency, with
  invert and new / add / subtract / intersect.
- Applying a mask uses what you see, density and feather included. A set's
  mask can be deleted but not applied (sets have no pixels); merging a set
  keeps what its mask showed. In a Pass Through set, the mask fades the
  set's whole effect.

## Type

Press **T**, click and type for point text, or drag a box for paragraph
text that wraps. Ctrl+Enter (or the ✓ button, or clicking elsewhere)
commits; Esc cancels. Click existing text, or double-click a type layer's
**T** thumbnail, to edit it. Type layers stay editable: move them, mask
them, change the font later, and undo works as one step per edit.

- **Fonts**: 115 open-license families ship inside the app, so they work
  offline and on any computer: sans serif (Inter, Roboto, Montserrat,
  Poppins...), serif (Playfair Display, Lora, EB Garamond, Merriweather...),
  display (Bebas Neue, Anton, Abril Fatface, Cinzel, Monoton, Press Start 2P,
  UnifrakturMaguntia...), comic and fun (Bangers, Luckiest Guy, Titan One,
  Comic Neue...), script and handwriting (Pacifico, Great Vibes, Dancing
  Script, Permanent Marker, Caveat...) and monospace (JetBrains Mono, Fira
  Code...). Most come in several weights and italics. Fonts installed on
  your computer are listed under **Installed**.
- **Font menu**: every font is previewed in itself; search, filter by
  category, try your own preview text; recently used fonts come first.
- **Character palette**: font, style, size, leading, tracking, baseline
  shift, vertical / horizontal scale, color, anti-aliasing (None, Sharp,
  Crisp, Strong, Smooth), faux bold / italic, all caps, underline,
  strikethrough.
- **Paragraph palette**: left / center / right / justify, convert between
  point and paragraph text.
- Painting, filters or adjustments on a type layer ask to **rasterize** it
  first (Layer > Rasterize > Type). Black & White to a new layer works
  without rasterizing.
- Settings apply to a whole type layer (one style per layer).

The fonts come from Google Fonts via Fontsource under the SIL Open Font
License or Apache 2.0; their licenses are in `public/fonts/licenses/`.
`scripts/build-fonts.mjs` rebuilds the set from `scripts/fonts.txt`.

## Liquify

**Filter > Liquify** (Ctrl+Shift+X) opens a full-window editor, as in PS7.

| Tool | Key | What it does |
| --- | --- | --- |
| Forward Warp | W | Pushes pixels along the drag |
| Reconstruct | R | Paints the distortion away, using the Reconstruct mode |
| Smooth | E | Evens out bumps in the distortion |
| Twirl Clockwise / Counterclockwise | C / L | Swirls pixels while the button is held (Alt reverses) |
| Pucker / Bloat | P / B | Pulls pixels toward the center / pushes them out |
| Push Left | O | Moves pixels sideways across the stroke (left going up; Alt for right) |
| Mirror | M | Reflects pixels across the stroke |
| Turbulence | T | Scrambles pixels smoothly (Turbulent Jitter sets how much) |
| Freeze Mask / Thaw Mask | F / D | Paints the areas that must not change |
| Face | A | Face-Aware Liquify (below) |
| Hand / Zoom | H, Space / Z | Pan; zoom (Alt zooms out, Ctrl+wheel, Ctrl+0 fits) |

Brush Size (`[` and `]`), Density, Pressure, Rate and stylus pressure work
as in PS. **Reconstruct** the whole image by an amount with the Revert,
Rigid, Stiff, Smooth or Loose mode (all but Revert keep the warp continuous
with frozen areas), or **Restore All**. **Mask Options** freeze from the
selection, the layer's transparency or its layer mask (replace, add,
subtract, intersect, invert), plus None, Mask All and Invert All. **View
Options** show the image, the mesh (three sizes, any color), the freeze mask
and a backdrop (all other layers or one of them, in front, behind or
blended, with opacity). Ctrl+Z / Ctrl+Shift+Z undo and redo inside the
dialog, stroke by stroke. **Save Mesh** and **Load Mesh** keep a distortion
in a file to reuse on another image of any size.

The preview runs on the GPU, so even big brushes are live. OK applies the
mesh to the full-resolution layer as one History step (inside the
selection, if there is one). Liquify is a command (`image.liquify`) whose
mesh is stored compactly, so it records into Actions and replays on any
image.

**Face-Aware Liquify.** With the Face tool (or Find Faces), Liquify finds
each face and its 478 landmarks. Sliders reshape the selected face: Eye
Size, Height, Width, Tilt and Distance (both eyes or each one), Nose Height
and Width, Smile, Upper and Lower Lip, Mouth Width and Height, Forehead,
Chin Height, Jawline and Face Width. Or drag right on the face: handles on
the eyes, mouth corners, lips, nose, chin, forehead, jaw and cheeks change
the matching slider. The face adjustments combine with brush work. Small
faces in group photos are found by looking again around each person's head.

## Face Swap

The **Face Swap tool** (J, in the toolbox slot under the Crop tool) puts a
face from one photo onto a face in another, or swaps faces within one
group photo.

1. Brush over the face you want to replace. A blue outline shows the face
   it found.
2. Click the window with the face you want to use (it can be the same
   picture) and brush over that face. It gets an orange outline.
3. Click **Swap** in the options bar (or press Enter).

The new face goes on a new layer called Face Swap, with a layer mask, so
you can hide it, lower its opacity, or paint the mask to adjust the edge.
Both faces stay marked: undo, change the options and Swap again, or brush
another face and swap the same new face in there too. The options bar shows
both faces as thumbnails; click one to choose which one the next stroke
marks, ⇄ swaps their roles, and Alt-brush always marks the face to use.

| Option | What it does |
| --- | --- |
| Match Lighting | How much of the original photo's light, shadows and skin tone the new face takes on |
| Soft Edge | How gradually the new face fades into the old one at its edge |
| Fill Hidden Side | When the new face is turned away from the camera, fill the side the camera can't see from its other side |
| Keep Hair & Glasses | Keep the original's hair, glasses and anything in front of the face on top |

How it follows a different angle: both faces get MediaPipe's 478
landmarks, and the canonical face mesh (898 triangles) is laid over each.
Every triangle of the face being replaced takes its pixels from the same
triangle of the new face, so the new face turns, tilts and stretches to the
original's pose and expression. Triangles the new face's photo only sees at
a steep angle are filled from their mirror image on the other side.
Triangles of the original that face away from the camera are skipped, so
the near side of a turned head always wins. If one mouth is open and the
other is closed, the original keeps its own mouth, so lips never smear over
teeth. The new face then takes on the original's lighting and skin tone
(the ratio of the two faces' heavily blurred colors), and hair, glasses and
the new face's own hair are kept out using the body-part model.

Face Swap uses the same one-time AI model download as Face-Aware Liquify.
It works best when both faces are reasonably large and the face to use
looks toward the camera; a face in profile can only give half a face.

## Files

**File > Save** (Ctrl+S) keeps everything: layers, sets, masks, type
layers (still editable), layer styles, guides, the selection and the
colors, in a **.cie** file. It is an ordinary zip: `doc.json` describes the
document, each layer's tiles are stored as they are in memory (empty ones
left out), and `preview.png` is a small flattened picture. Saving and
opening compress in the background, so large files don't freeze the
window. **Save a Copy as PNG / JPEG** writes the flattened picture without
changing which file the window belongs to. Open Recent lists the last 12
files, Revert (F12) goes back to the saved file, and the installer
registers .cie so double-clicking one (in Explorer or Finder) opens it.

## Several Layers

In the Layers palette, **Ctrl-click** (Cmd on a Mac) adds a layer to the
selection or takes it out, and **Shift-click** selects every layer between
the active one and the one you click. Selected layers are highlighted;
Select > All Layers (Ctrl+Alt+A) and Select > Deselect Layers do the
obvious. Everything that makes sense for several layers works on all of
them: the Move tool and arrow keys, Free Transform, delete, duplicate,
Merge Layers (Ctrl+E), opacity, blend mode and visibility, Layer > Link
Layers, Layer > New > Set From Selected (Ctrl+Alt+G), and **Layer > Align**
and **Layer > Distribute** (also buttons on the Move tool's options bar).
With one layer and a selection, Align lines the layer up with the
selection.

**Hold Ctrl for the Move tool.** With any tool, holding Ctrl switches to the
Move tool until you let go, so you can nudge a layer without leaving the
brush. While using the Pen tools, Ctrl gives Direct Selection instead, as
in Photoshop. It can be turned off in Edit > Preferences > Tools.

**The Move tool moves the layers you chose.** Its options bar has
**Auto-Select: Off / Layer / Layer Set**, Off by default: clicking
anywhere moves the layers selected in the Layers palette. Layer (or Layer
Set) picks whatever is under the pointer instead. Photoshop's habit of
Ctrl-click turning Auto-Select on for one click is a preference (Tools),
off by default, so holding Ctrl never switches layers by accident. **Show
Bounding Box** draws handles around the layers; dragging one turns
straight into Free Transform.

## Keyboard

Photoshop 7's tool letters and menu shortcuts work for everything the editor has (Help >
Keyboard Shortcuts lists them; Edit > Keyboard Shortcuts changes them).
Besides those:

| Keys | Does |
| --- | --- |
| Hold Space / Ctrl / Ctrl+Space / Ctrl+Alt+Space | Hand / Move / Zoom in / Zoom out, until you let go |
| Hold Alt with the Brush, Pencil, Paint Bucket, Gradient or Color Replacement | Eyedropper (click picks the foreground color) |
| Alt with Dodge / Burn, Blur / Sharpen, the Eraser | The opposite tool; Erase to History |
| Alt over a point with the Pen / Add / Delete Anchor | Convert Point / the other anchor tool |
| 1 ... 0, or two quick digits (4, 5 = 45%) | The tool's opacity, exposure or strength; with other tools, the layer's opacity. Shift for flow |
| Shift+= / Shift+- , Alt+Shift+N, M, S, O... | Next / previous blend mode, or one by its letter (the painting tool's mode, else the layer's) |
| Alt+[ / Alt+] , Shift+Alt+[ / ] | Select the layer below / above, the bottom / top layer |
| Ctrl+Alt+Shift+E | Merge everything visible into a new layer |
| / | Lock transparent pixels |
| Ctrl+Shift+T | Transform Again |
| Shift+Alt+Backspace / Ctrl+Shift+Backspace | Fill with the foreground / background color, keeping transparency |
| F5, F6, F7, F8, F9 | Brushes, Color, Layers, Info, Actions palettes |
| Tab / Shift+Tab | Hide all palettes / all but the toolbox |
| Page Up / Page Down (Ctrl: left / right), Home, End | Scroll a screen (Shift: 10 pixels), go to a corner |
| Space while drawing a marquee | Move the marquee |
| Alt+arrow with the Move tool | Nudge a copy |
| Enter | Jump to the options bar's first field |
| Caps Lock | Precise cursors |
| Double-click the Hand / Zoom tool | Fit on Screen / Actual Pixels |
| Ctrl+K / Ctrl+Alt+K | Preferences / the last Preferences section |

## Preferences

Edit > Preferences (Ctrl+K) is laid out like Photoshop 7's, one section at a
time (Prev / Next, or the list):

- **General:** Color Picker (the built-in, Photoshop-style one with HSB,
  RGB, Lab, CMYK and hex, or the system's), default image interpolation
  for Image Size and Free Transform, the Redo key (PS7's Ctrl+Z toggle, or
  Ctrl+Z undoing many steps with Ctrl+Shift+Z or Ctrl+Y to redo), history
  states, theme, floating or maximized windows, tool tips, keyboard zoom
  resizing windows, zooming with the scroll wheel, a beep when long
  operations finish, dynamic color sliders, saving palette locations, and
  using Shift to switch tools.
- **Tools:** Ctrl for the Move tool, Ctrl-click auto-select, Alt for the
  Eyedropper, Free Transform keeping proportions.
- **File Handling:** previews in .cie files, lower- or upper-case
  extensions, JPEG quality, the length of Open Recent, and how often
  recovery copies are saved.
- **Display & Cursors:** painting and other cursors, a crosshair in the
  brush outline, the pixel grid.
- **Transparency:** checkerboard size and colors, the mask overlay.
- **Units & Rulers:** ruler and type units, the resolution for new
  images, PostScript or traditional points.
- **Guides, Grid & Slices:** colors and line styles, grid spacing in any
  unit with subdivisions, slice color and numbers.
- **Scratch Disks** and **Memory:** see below.

Images now have a resolution (pixels per inch): set in New and Image Size,
read from and written to PNG and JPEG files, and used by rulers, the Info
palette and type sizes in points or millimetres.

## Memory and Scratch Disks

Like Photoshop, the editor can use **scratch disks**: in Edit > Preferences
> Scratch Disks, choose up to four folders on any drives (the system's
temporary folder is the default). **Memory** sets how much of the
computer's memory open images and their history may use. When they need
more, the oldest history steps are written to the first scratch disk with
room, then the next, and dropped from memory; going back to one in the
History palette (or with undo) reads it in again. Steps on the scratch
disk are marked in the History palette, and the status bar's ▸ menu can
show **Scratch Sizes** (memory used / allowed) and **Efficiency** like PS7.
Edit > Purge frees memory straight away. In a browser the scratch disk is
the browser's private storage for the site.

**Crash recovery:** every 10 minutes (File Handling) a copy of each image
with unsaved changes goes to the scratch disk. Saving or closing the image,
or quitting normally, deletes it; if the editor stops unexpectedly, the next
start offers to open the copies.

## Shapes and Paths

The **Pen** (P) clicks corner points and drags smooth ones; click the first
point to close the path. The **Freeform Pen** draws a path as you drag.
**Add / Delete Anchor Point** and **Convert Point** edit a path, the
**Path Selection** tool (A) moves whole paths, and **Direct Selection**
drags single anchors and handles. The **Rectangle, Rounded Rectangle,
Ellipse, Polygon** (sides, star indent), **Line** (weight, arrowheads) and
**Custom Shape** tools (U) draw in one of two modes chosen on the options
bar: **Shape Layers**, editable vector layers that stay sharp when scaled,
rotated or resized (double-click the thumbnail to change the color, Layer >
Rasterize > Shape to turn one into pixels), or **Paths**, which add to the
work path. The **Paths** palette (next to Layers and Channels) lists the
work path, saved paths and the active shape layer's outline, and fills,
strokes, loads a path as a selection or makes a work path from the
selection.

## Notes, Slices and Measuring

The **Notes** tool (N) pins a note with an author and color to the image;
click it to read or edit. **Slice** (K) cuts the image into rectangles and
**Slice Select** moves and resizes them; File > Export > Slices saves every
slice as a PNG in one zip. Notes and slices are kept in .cie files and
follow crops, resizes and rotations. The **Color Sampler** (I) leaves up to
four fixed readouts in the Info palette, and the **Measure** tool reads out
distance and angle; its Straighten button rotates the image level.

## Transform

**Edit > Free Transform** (Ctrl+T) puts a box around the layer (or the
selected pixels, which then float on their own, or every selected layer).
Drag inside to move, drag a handle to scale (corners keep proportions;
Shift-drag to scale freely; Alt scales from the center), drag outside to
rotate (Shift snaps to 15°). If you prefer Photoshop 7's way, where Shift
keeps proportions, turn off Edit > Preferences > Tools > "Free Transform
keeps proportions". Ctrl-drag a corner
to distort, Ctrl-drag an edge to skew, Ctrl+Alt+Shift-drag a corner for
perspective. The reference point can be dragged; the options bar takes
exact X, Y, W, H and angle. Enter or double-click applies, Esc cancels,
and Ctrl+Z inside the transform undoes the last handle drag. Edit >
Transform has the same modes plus Rotate 180° / 90° and Flip, and
Select > Transform Selection reshapes just the outline.

## Retouching

| Tool | How |
| --- | --- |
| Spot Healing Brush (J) | Paint over a blemish, dust spot, wire or small object; when you let go it is filled from what surrounds it |
| Healing Brush (J) | Alt-click a clean area, then paint over the flaw: the texture is copied and its color and light are blended to match the new spot, so there is no visible patch |
| Red Eye Tool (J) | Click a red pupil, or drag a box around the eye |
| Clone Stamp (S) | Alt-click the source, then paint. Aligned keeps the offset between strokes; Use All Layers copies what you see |
| History Brush (Y) | Paint back the image as it was opened, or a named snapshot |
| Dodge / Burn / Sponge (O) | Lighten or darken shadows, midtones or highlights (Alt swaps Dodge and Burn); saturate or desaturate |
| Blur / Sharpen / Smudge (R) | Soften or crisp detail where you paint (Alt swaps); push paint around like a finger |
| Magic Eraser (E) | Click a color to erase it and similar colors to transparency |
| Patch Tool (J) | Select the flaw (or, in Destination mode, the clean area) and drag it onto clean texture; it is blended in like the Healing Brush |
| Pattern Stamp (S) | Paints with the chosen pattern (Edit > Define Pattern adds your own); the tiles line up across strokes |
| Art History Brush (Y) | Paints stylized strokes (tight or loose, short to long, dab, curl) from the history source |
| Color Replacement (B) | Recolors what you paint with the foreground color, keeping its shading (Color, Hue, Saturation or Luminosity mode) |
| Background Eraser (E) | Erases the color under the center of the brush to transparency (contiguous or discontiguous, tolerance, Protect Foreground Color) |
| Magnetic Lasso (L) | Snaps to edges as you move; click to add a point, double-click or Enter to close |

**Content-Aware Fill** (Edit > Content-Aware Fill, or Shift+Backspace):
draw a loose selection around something you want gone, and it is replaced
with texture from around it. It works the way Photoshop's does: on a
pyramid from coarse to fine, every patch of the hole finds its best match
in the surroundings (PatchMatch), and each pixel becomes the weighted vote
of the patches covering it. Matching also compares local texture, so fills
don't wash out into flat color. It runs in the background with a Cancel
button, and running it again gives a different fill. The Spot Healing
Brush uses the same engine. **Layer > Remove Background** finds the people
in the photo with the on-device AI model and hides everything else with a
layer mask you can paint.

## Layer Styles

Double-click a layer's thumbnail, use the fx button at the bottom of the
Layers palette, or Layer > Layer Style to add **Drop Shadow, Inner Shadow,
Outer Glow, Inner Glow, Bevel and Emboss (inner, outer, emboss, pillow),
Color Overlay and Stroke**. The dialog previews on the canvas as you drag.
Effects follow the layer: paint, move, transform or edit its text and they
update. An fx badge marks styled layers; Copy / Paste / Clear Layer Style
and Layer > Rasterize > Layer Style are in the Layer menu, and the
**Styles** palette (next to Color and Swatches) applies ready-made looks
(shadows, sticker, outlines, neon, emboss, gold, chrome, inset, comic).
Merging and flattening keep the effects.

## Selecting People

**Select > Subject** selects everyone in the picture in one step.
**Select > People...** opens a dialog that shows each person it found, with
a thumbnail and a number on the picture:

- Pick people with the checkboxes, All / None / Invert, or by clicking them
  in the picture (Alt-click: only that person).
- Pick parts: the whole person, or any mix of Hair, Face, Skin (Body),
  Clothes and Accessories (hats, glasses, bags).
- Edge: Refine Edge snaps the outline to the photo (strands of hair and
  other fine detail), plus Smooth, Shift Edge and Feather.
- View it as an overlay (any color), on black, on white, as a black and
  white mask, or the original.
- Output to a selection (new, add, subtract, intersect), a layer mask, a
  new layer, or a new layer with a layer mask.

How it works: a body-part segmentation model (MediaPipe's multiclass
selfie model) runs over the whole picture to find people and label hair,
face, skin and clothes. Each head seeds one person, and a path search that
favors going down from the head and avoids crossing color edges splits
people who touch. Every person is then segmented again from a close crop,
which recovers detail the first pass is too coarse for, and a guided filter
fits the edge to the photo. The result is cached until the pixels change,
so changing the choice of people or parts is instant.

`select.subject` and `select.people` are commands like any other (people
are numbered from the left; parts by name), so they record into Actions and
run in Batch.

**The AI models.** People selection, Face-Aware Liquify and Face Swap use on-device
models: MediaPipe's vision runtime, its multiclass segmentation model and
its face landmarker (by Google, Apache 2.0). They are 33 MB, too big to
carry inside the program, so the first time you use one of these features the
editor offers a one-time download. After that they work offline, and your
images never leave the computer. On a machine without internet, use Load
Files... in the same dialog with the four files copied from another
computer (on Windows they are in `%LOCALAPPDATA%\app.classicimageeditor.desktop\models`,
on macOS in `~/Library/Application Support/app.classicimageeditor.desktop/models`,
on Linux in `~/.local/share/app.classicimageeditor.desktop/models`). Help >
AI Models... shows what is installed and can remove the files. Every file
is pinned to one version and checked against its SHA-256 after download.
MediaPipe's license is in `public/licenses/`.

## Filter Library

**Filter > Filter Library** shows every filter as a thumbnail of your own
picture. Click one to preview it large and tune its settings; double-click
or press Enter to apply. Hold the mouse on the preview to compare with the
original. Filters run in a background worker, so the window stays
responsive, and big images show a Cancel button.

| Category | Filters |
| --- | --- |
| Cartoon & Comic | Cartoon, Comic Book, Cel Shading, Anime, Ink Drawing, Marker Drawing, Sketchy Toon, Comic Noir, Pop Art, Pop Art Grid, Ben-Day Dots, Manga Screentone, Paint by Numbers, Vector Art |
| Artistic | Oil Paint, Impressionist, Swirling Strokes, Watercolor, Gouache, Ink Wash (Sumi-e), Pointillism, Dry Brush, Palette Knife, Paint Daubs, Smudge Stick, Sponge, Rough Pastels, Colored Pencil, Fresco, Plastic Wrap, Underpainting, Pastel Wash, Poster Edges, Neon Glow, Cutout, Mosaic Tiles |
| Sketch | Pencil Sketch, Charcoal, Chalk & Charcoal, Graphic Pen, Conté Crayon, Crosshatch, Engraving, Water Paper, Halftone Pattern, Photocopy, Stamp, Bas Relief, Chrome, Reticulation, Torn Edges, Blueprint |
| Blur | Blur, Blur More, Gaussian, Box, Motion, Radial (spin/zoom), Smart, Surface, Lens (bokeh), Tilt-Shift, Average, Soft Focus |
| Sharpen | Sharpen, Sharpen More, Sharpen Edges, Unsharp Mask, Clarity, High Pass Sharpen |
| Noise | Add Noise, Film Grain, Despeckle, Median, Dust & Scratches, Reduce Noise, Deep Fried |
| Distort | Twirl, Pinch, Spherize, Fisheye, Ripple, Wave, ZigZag, Polar Coordinates, Glass, Ocean Ripple, Liquid Warp, Kaleidoscope, Mirror, Diffuse Glow, RGB Split, Glitch |
| Pixelate | Mosaic, Crystallize, Stained Glass, Pointillize, Color Halftone, Fragment, Mezzotint, Facet, Hexagons, Low Poly, Toy Bricks, LED Screen, Cross Stitch |
| Stylize | Find Edges, Glowing Edges, Neon Lines, Emboss, Color Emboss, Solarize, Trace Contour, Wind, Diffuse, Tiles, Extrude, Outline Glow |
| Render | Clouds, Difference Clouds, Fibers, Plasma, Lens Flare, Light Rays, Speed Lines |
| Photo Looks | Sepia, Vintage Film, Cross Process, Lomo, Infrared, Bleach Bypass, Teal & Orange, Cinematic, Instant Film, Golden Hour, Day for Night, Night Vision, Thermal Camera, X-Ray, Duotone, Tritone, Two-Strip Technicolor, Neon Night, Color Splash, Vignette |
| Retro & Pixel | Pixel Art (Game Boy, NES, C64, CGA, PICO-8 palettes...), Dither (Bayer, Floyd-Steinberg, Atkinson), VHS Tape, CRT Screen, Newsprint, Pixel Sort, 3D Anaglyph |
| Texture | Texturizer, Grain, Craquelure, Patchwork, Picture Frame |
| Color & Tone | the adjustments above, plus Hue Rotate, Invert Brightness, Random Color Wash |
| Other | High Pass, Minimum, Maximum, Offset, Custom (3 x 3 kernel) |

**Painting engine.** The Cartoon, Artistic and Sketch filters (36 of
them) are built on a shared painting engine instead of pixel tricks. It
finds the picture's structure first: edge-aware smoothing simplifies shapes
without blurring edges, and a flow field follows the direction of every
contour. Paint filters then lay down real strokes that follow that flow,
largest brushes first, with bristle streaks, impasto height lit from one
side, pigment pooling and paper or canvas texture. Ink and pencil filters
draw flow-following lines (difference-of-Gaussians along the flow) and
hatch the shadows in layered directions. Big images are painted at a
working size of about 3 megapixels and scaled up, so they stay quick.

**Organizing.** Star filters to put them in Favorites. Make your own
collections (the + next to Collections, or right-click a filter > Add to
Collection) and drag filters onto them; drag inside a collection to reorder.
Hide filters you never use from the menus. Recently Used fills itself.
Search matches names, categories, descriptions and tags ("toon", "bokeh",
"warhol"). Every filter remembers the settings you used last, and you can
save named settings per filter. Favorites, Recently Used and your
collections appear at the top of the Filter menu. Organize > Export /
Import moves your organization between machines.

Every filter is also a command (`filter.cartoon`, `filter.gaussianBlur`, ...)
with a JSON schema, so Actions, batch runs and the upcoming AI assistant can
use all of them.

## Black & White Lab

**Image > Adjustments > Black & White Lab** (Ctrl+Alt+Shift+B), also in the
Filter menu.

- Six color sliders (reds, yellows, greens, cyans, blues, magentas) decide how
  bright each color becomes. **Drag left or right on the picture** to
  change the slider for the color under the cursor; the Auto button finds
  the mix with the widest tonal range.
- Presets with live thumbnails: lens filters (red, orange, yellow, green,
  blue, infrared...), film stocks (Tri-X 400, HP5 Plus, T-Max 100, Neopan
  Acros, Delta 3200, Pan F 50...), and looks (Ansel, Film Noir, Soft
  Portrait, Street Grit, Silver Gelatin, Holga, High Key, Low Key, Antique
  Sepia, Cyanotype, Platinum). Save your own.
- Tone: brightness, contrast, blacks, shadows, highlights, whites, clarity.
- Film grain (amount, size, roughness), halation glow, vignette.
- Toning: sepia, selenium, platinum/palladium, cyanotype, gold, coffee, blue
  steel, or your own split tone.
- A split before/after view with a draggable divider (\\ toggles before),
  a histogram with the tone curve, and Ansel Adams' zones 0 to X: hover the
  picture to see which zone a spot lands in.
- Output to a new layer (default) or the layer itself. Fade works after it.

## Actions

The **Actions** palette (next to History) records what you do and plays it
back.

- **Record:** click New Action, name it, pick a function key (F2 to F12, with
  Shift and/or Ctrl) and a color, and start working. Stop when done.
- **Play:** select an action and click Play, press its function key, or turn
  on **Button Mode** for a grid of colored buttons.
- Each step can be turned off. Steps that have a dialog (filters, the B&W
  Lab) have a dialog toggle: on means playback stops to let you adjust the
  settings. Double-click a step to change its recorded settings.
- Drag to reorder actions and steps; double-click an action for its options.
- Sets save to and load from files (palette menu > Save / Load Actions).
- Playback options: accelerated, step by step, or a pause between steps.
- The default set includes Cartoonize (F2), Tri-X Black & White (F3),
  Sharpen for Web (F4), Soft Glow Portrait (F6), Comic Page (F7), Vintage
  Postcard (F8), Pop Art Quad (F9) and Pencil Drawing (Shift+F2).

### Batch

**File > Automate > Batch** (or Batch in the Actions palette menu) runs an
action on many images: pick images or a whole folder (with subfolders),
choose whether step dialogs show, and where results go. In the desktop app
they are saved to a folder you choose (optionally keeping subfolders); in a
browser they download together as one .zip. Name results with a suffix and
optional numbering, save as JPEG (with quality) or PNG, and either stop at
the first error or log errors and keep going. A progress window lists every
file.

## Appearance

The editor works like it's 2002, but it doesn't look like it. Pick a theme
under **Window > Appearance**:

| Theme | Feel |
| --- | --- |
| Graphite (default) | Neutral dark grey, cobalt accent |
| Darkroom | Warm black with a safelight-amber accent |
| Cyanotype | Deep Prussian blue, pale cyan accent |
| Slate | Mid grey, easy on the eyes for long sessions |
| Moss | Green-grey dark, lichen accent |
| Dusk | Plum-tinted dark, lilac accent |
| Studio | Clean light grey, blue accent |
| Linen | Warm light, teal accent |
| Classic 2002 | The old grey and navy, flattened |
| High Contrast | Black and white with a yellow accent |

**Window > Appearance > Customize Appearance...** previews every theme live,
lets you change any of its nine colors (bars and toolbox, panels and windows,
buttons and tabs, text fields, borders, text, secondary text, accent, image
area), set corners to square, soft or round, and pick small, medium or large
text. Save the result as your own theme by name; it appears with the others
and is remembered. Every built-in theme is checked for readable contrast
(WCAG AA for secondary text, AAA for main text) by the unit tests.

## Customizing the workspace

Everything about the layout is yours to arrange, and it is remembered between
sessions.

- **Move palettes.** Drag a palette by its title strip to float it anywhere.
  Drop it on the right-hand column to dock it again.
- **Regroup palettes.** Drag a palette's tab onto another palette's tabs to
  join that group, onto the dock column to make a new docked group, or
  anywhere else to make it a floating window of its own.
- **Palette well.** Drag a tab onto the palette well (right end of the
  options bar) to keep it there; click its tab in the well to pop it open.
  Use "Remove from Palette Well" in its menu to take it out.
- **Collapse, resize, close.** Double-click a tab or title strip to collapse
  a group, drag the corner grip to resize, use the x on floating palettes to
  close them, and drag the dock's left edge to change its width.
- **Toolbox.** Drag it by its header to float it; drop it near the left
  edge (or double-click the header) to dock it.
- **Show and hide.** The Window menu lists every palette, plus the Tools,
  Options bar and Status bar. Tab hides all palettes; F cycles screen modes.
- **Workspaces.** Window > Workspace > Save Workspace saves the current
  layout under a name (optionally with your keyboard shortcuts). Saved
  workspaces appear in that menu to switch between. Also: Delete Workspace,
  Reset Palette Locations, and Export / Import Workspace to move a layout
  to another computer as a JSON file.
- **Keyboard shortcuts.** Edit > Keyboard Shortcuts (Ctrl+Alt+Shift+K)
  lets you change any menu command, tool letter or painting shortcut.
  Conflicts are resolved for you; "Defaults" restores PS7's set.
  Help > Keyboard Shortcuts Reference (F1) lists the current ones.

Settings are stored in the app's local storage, which the desktop app keeps
across restarts.

## How it is built

```
src/
  core/          document model, no UI or GPU code (unit-tested in Node)
    tiles.ts       256x256 RGBA tiles, copy-on-write
    mask.ts        8-bit tiled masks (selections, layer masks)
    selection.ts   shapes, magic wand, Color Range, feather, modify, outline
    document.ts    layer tree (layers and sets), snapshots
    composite.ts   CPU reference compositing (masks, clipping, sets)
    blend.ts       the 22 blend modes (reference math)
    brush.ts       stroke engine (dynamics, pressure, paint modes, targets)
    brushes.ts     brush presets and sampled tips
    commands.ts    CommandBus: named commands with JSON-Schema parameters
    history.ts     History palette model and snapshots
    cmd/           every command: layers, select, edit
    liquify.ts     Liquify displacement field, brush tools, reconstruct, mesh encoding
    transform.ts   projective warps for Free Transform
    resample.ts    Bicubic / Bilinear / Lanczos resampling for Image Size
    inpaint.ts     PatchMatch hole filling and seamless (healing) blending
    retouch.ts     stroke engine for the healing, clone, toning and focus tools
    styles.ts      layer effects, computed per layer and cached
    scratch.ts     paging old history to the scratch disk and back
    vector.ts      paths: anchors and handles, flattening, filling, stroking
    shapes.ts      the shape tools' outlines and shape layers
    patterns.ts    patterns for fills and the Pattern Stamp
  ai/            people and face detection (MediaPipe models, run on the CPU)
    people.ts      finding people, telling them apart, edge-refined mattes
    faceaware.ts   Face-Aware Liquify warps from face landmarks
    models.ts      the one-time model download and storage
  filters/       the filter library; paint.ts is the painting engine
  gl/            WebGL2 compositor and shaders
  tools/         toolbox tools
  ui/            menus, toolbox, options bar, palettes, workspace, shortcuts, dialogs
  io/            open, save, clipboard
src-tauri/       Rust shell (Tauri 2)
tests/           unit tests (Vitest)
e2e/             browser end-to-end checks (Playwright)
```

**One path for every edit.** Menus, shortcuts, tools and scripts all call
`CommandBus.dispatch(name, params)`. Each command declares a JSON-Schema for
its parameters, so the bus validates input, records History, and can hand
the whole command list to an LLM as tools (`bus.toolSchemas()`). That is the
foundation for the Ollama features in M2: the AI will call the same commands
you do, and every AI change is one undoable History step (`bus.group(...)`).

Open the developer console and try:

```js
editor.commands()                                   // everything available
editor.run("select.ellipse", { x: 50, y: 50, w: 300, h: 200, feather: 10 })
editor.run("layer.new", { name: "shade" })
editor.run("edit.fill", { use: "black" })
editor.run("layer.setProperties", { blendMode: "multiply", opacity: 40 })
```

**Compositing.** Layers are stored as tiles; only tiles that changed are
re-blended on the GPU into one canvas-sized texture, so panning and zooming
never re-blend layers and a brush dab only touches the tiles under it. Layer
masks, clipping groups and layer sets are composited on the GPU exactly as
the CPU reference does; the end-to-end suite checks the two agree.

## Tests

```bash
npm test                         # 480 unit tests
npm run build && npm run e2e     # browser checks + screenshots in e2e/out/
E2E_BROWSER=webkit npm run e2e   # the same checks in WebKit (macOS / Linux engine)
```

The end-to-end suite drives the real UI with mouse and keyboard: every
selection tool, Quick Mask, painting with brush dynamics, copy and paste,
the Layers palette, layer masks (thumbnail clicks, the Masks palette,
unlinked moves, drag to the trash, the Gradient tool), the Type tool and font
menu, Liquify (tools, undo, apply, cancel), Content-Aware Fill, the
Spot Healing Brush and Clone Stamp, Free Transform, the Layer Style
dialog, Levels, saving and reopening a .cie file, holding Ctrl for the Move
tool, selecting, moving, aligning and transforming several layers, the
Rectangle and Pen tools and the Paths palette, notes, slices, the Measure
tool and the Pattern Stamp, the Move tool's Auto-Select, the temporary
tools (Alt Eyedropper, Ctrl+Space zoom), layer stepping, blend mode and
number keys, Transform Again, the Preferences dialog, the Color Picker,
scratch disk paging with undo, crop, rulers and guides, dragging palettes and tabs
around, saving / resetting / loading workspaces, restarts, and remapped
shortcuts. With the model files and two test photos in `e2e/models/` it
also checks the model download, Select People on a group photo, Select
Subject, Face-Aware Liquify and a Face Swap between two windows.

## Known limits

- Images are limited to the GPU's maximum texture size per side (usually 16384 px).
- 8 bits per channel, RGB only.
- Each open image window uses its own WebGL context (closed windows hand
  theirs on to the next one); browsers allow about 16 at once, so close
  some images if a new one won't open.
- Layer sets don't nest (as in PS7).
- Texture and Dual Brush, Wet Edges, vector masks, adjustment layers and
  type on a path come later.
- Layer effects are computed on the CPU; on photo-sized layers, dragging
  the Layer Style sliders updates at a few frames per second.
- An unlinked mask only stores the area of its layer; moving it far off and
  back fills the uncovered part with the mask's default (all shown or all
  hidden).
- People selection works on people (not pets or objects), and very
  crowded or backlit scenes can merge two people into one; pick the
  merged person and use Subtract with a lasso, or refine on a layer mask.
- Opening and saving use the webview's image codecs; TIFF, PSD and 16-bit
  arrive with the file-format milestone.
- Only history is paged to the scratch disk: the open images themselves
  (their current state) always stay in memory.
- CMYK and Lab values in the Color Picker are uncalibrated (no color
  profiles yet).

## Roadmap

Done since the plan: M3's filters and adjustments, M4's Actions and Batch,
full layer masks with the Gradient tool, the Type tool with a bundled
font library, and in 0.7 Liquify (with Face-Aware Liquify), a rebuilt
painting engine for the artistic filters, and AI people selection; in
0.8 the Face Swap tool; in 0.9 layered .cie files, Image Size and Canvas
Size, Free Transform, Levels / Curves / Color Balance, the retouching
tools, Content-Aware Fill and layer styles; in 0.10 multi-layer
selection, Ctrl for the Move tool, the pen and shape tools with shape
layers and paths, and the rest of the PS7 toolbox; in 0.11 Photoshop's
keyboard and temporary tools, Auto-Select off by default, the full
Preferences dialog, image resolution and units, scratch disks and crash
recovery.
Next is **M2: AI palette v1**: natural-language commands through Ollama tool
calling, and image understanding with vision models.

Not affiliated with or endorsed by Adobe.
