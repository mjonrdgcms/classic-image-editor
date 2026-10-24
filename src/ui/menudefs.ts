/** The menu bar's contents, in PS7's order. */

import { recentMenu } from "./actions";
import type { App } from "../app";
import type { Actions } from "./actions";
import type { MenuItem } from "./menus";
import type { ThemeManager } from "./theme";
import type { FilterOrg } from "./filterorg";
import { CATEGORIES, FILTERS, FILTER_MAP } from "../filters";
import type { Workspace } from "./workspace";

const soon = (label: string, milestone: string, shortcut?: string): MenuItem => ({ label, soon: milestone, shortcut });

export function buildMenus(app: App, a: Actions, ws: Workspace, themes: ThemeManager, fx: { org: FilterOrg; open: (id: string) => Promise<void> }): { title: string; items: MenuItem[] | (() => MenuItem[]) }[] {
  return [
    {
      title: "File",
      items: [
        a.new,
        a.open,
        recentMenu(app),
        "-",
        a.close,
        a.closeAll,
        a.save,
        a.saveAs,
        a.savePng,
        a.saveJpeg,
        soon("Save for Web...", "1.x"),
        a.revert,
        "-",
        soon("Import", "M4"),
        { label: "Export", submenu: [a.exportSlices] },
        { label: "Automate", submenu: [a.batch] },
        "-",
        soon("Print...", "1.x", "Ctrl+P"),
      ],
    },
    {
      title: "Edit",
      items: [
        a.undo,
        a.stepForward,
        a.stepBackward,
        "-",
        a.cut,
        a.copy,
        a.copyMerged,
        a.paste,
        a.pasteInto,
        a.clear,
        "-",
        a.fill,
        a.contentAwareFill,
        a.stroke,
        "-",
        a.freeTransform,
        { label: "Transform", submenu: [a.transformAgain, "-", a.tScale, a.tRotate, a.tSkew, a.tDistort, a.tPerspective, "-", a.tRot180, a.tRotCW, a.tRotCCW, "-", a.tFlipH, a.tFlipV] },
        "-",
        a.defineBrush,
        a.definePattern,
        "-",
        { label: "Purge", submenu: [a.purgeUndo, a.purgeClipboard, a.purgeHistories, "-", a.purgeAll] },
        "-",
        a.keyboardShortcuts,
        a.preferences,
      ],
    },
    {
      title: "Image",
      items: [
        soon("Mode", "M3"),
        {
          label: "Adjustments",
          submenu: [
            a.levels,
            a.autoLevels,
            a.autoContrast,
            a.autoColor,
            a.curves,
            a.colorBalance,
            a.brightnessContrast,
            a.exposure,
            a.shadowsHighlights,
            "-",
            a.hueSaturation,
            a.vibrance,
            a.whiteBalance,
            a.photoFilter,
            a.desaturate,
            a.channelMixer,
            a.gradientMap,
            "-",
            a.bwLab,
            "-",
            a.invert,
            a.equalize,
            a.threshold,
            a.posterize,
          ],
        },
        "-",
        a.duplicateImage,
        soon("Apply Image...", "1.x"),
        "-",
        a.imageSize,
        a.canvasSize,
        { label: "Rotate Canvas", submenu: [a.rotate180, a.rotateCW, a.rotateCCW, a.rotateArbitrary, "-", a.flipCanvasH, a.flipCanvasV] },
        a.cropToSelection,
        a.trim,
        "-",
        a.histogram,
      ],
    },
    {
      title: "Layer",
      items: [
        { label: "New", submenu: [a.newLayer, a.fromBackground, a.newSet, a.newSetFromLinked, a.newSetFromSelected, "-", a.layerViaCopy, a.layerViaCut] },
        a.duplicateLayer,
        a.deleteLayer,
        "-",
        a.layerProperties,
        {
          label: "Layer Style",
          submenu: [
            a.styleBlending,
            "-",
            a.style_dropShadow,
            a.style_innerShadow,
            a.style_outerGlow,
            a.style_innerGlow,
            a.style_bevel,
            a.style_colorOverlay,
            a.style_stroke,
            "-",
            a.copyStyle,
            a.pasteStyle,
            a.clearStyle,
          ],
        },
        "-",
        soon("New Fill Layer", "M3"),
        soon("New Adjustment Layer", "M3"),
        "-",
        {
          label: "Add Layer Mask",
          submenu: [a.maskRevealAll, a.maskHideAll, a.maskRevealSel, a.maskHideSel, "-", a.maskFromTransparency],
        },
        { label: "Remove Layer Mask", submenu: [a.maskDelete, a.maskApply] },
        a.removeBackground,
        a.maskToggle,
        {
          label: "Type",
          submenu: [a.editText, "-", a.rasterizeTypeLayer, a.typeConvert, "-", a.showCharacter, a.showParagraph],
        },
        { label: "Rasterize", submenu: [a.rasterizeType, a.rasterizeShape, a.rasterizeStyle] },
        a.shapeColor,
        {
          label: "Layer Mask",
          submenu: [
            a.editMask,
            a.editLayer,
            "-",
            a.maskOverlayToggle,
            a.maskViewGray,
            a.maskOptions,
            "-",
            a.maskLinkToggle,
            a.maskInvert,
            a.maskEdge,
            a.maskFromSelection,
            a.loadMaskSelection,
            "-",
            a.showMasks,
          ],
        },
        "-",
        a.groupWithPrevious,
        a.ungroup,
        "-",
        { label: "Arrange", submenu: [a.bringToFront, a.bringForward, a.sendBackward, a.sendToBack] },
        { label: "Align", submenu: [a.align_top, a.align_vcenter, a.align_bottom, "-", a.align_left, a.align_hcenter, a.align_right] },
        { label: "Distribute", submenu: [a.distribute_top, a.distribute_vcenter, a.distribute_bottom, "-", a.distribute_left, a.distribute_hcenter, a.distribute_right] },
        a.linkSelected,
        "-",
        a.mergeDown,
        a.mergeVisible,
        a.stampVisible,
        a.flatten,
      ],
    },
    {
      title: "Select",
      items: [
        a.selectAll,
        a.deselect,
        a.reselect,
        a.inverse,
        "-",
        a.colorRange,
        a.selectSubject,
        a.selectPeople,
        "-",
        a.feather,
        { label: "Modify", submenu: [a.border, a.smooth, a.expand, a.contract] },
        "-",
        a.grow,
        a.similar,
        "-",
        a.selectAllLayers,
        a.deselectLayers,
        "-",
        a.transformSelection,
        "-",
        a.loadSelection,
        soon("Save Selection...", "1.x (Channels)"),
        "-",
        a.quickMask,
      ],
    },
    {
      title: "Filter",
      items: () => {
        const item = (id: string) => {
          const f = FILTER_MAP.get(id)!;
          return { label: f.name + (f.params.length ? "..." : ""), enabled: () => app.hasDoc && app.bus.isEnabled(`filter.${id}`), run: () => void fx.open(id) };
        };
        const visible = (ids: string[]) => ids.filter((id) => FILTER_MAP.has(id));
        const out: MenuItem[] = [a.lastFilter, a.lastFilterDialog, a.fade, "-", a.filterLibrary, a.liquify, a.bwLab, "-"];
        const favs = visible(fx.org.data.favorites);
        if (favs.length) out.push({ label: "★ Favorites", submenu: favs.map(item) });
        const recent = visible(fx.org.data.recent);
        if (recent.length) out.push({ label: "Recently Used", submenu: recent.map(item) });
        for (const c of fx.org.data.collections) if (c.filters.length) out.push({ label: c.name, submenu: visible(c.filters).map(item) });
        out.push("-");
        for (const cat of CATEGORIES) {
          const list = FILTERS.filter((f) => f.category === cat && !fx.org.isHidden(f.id));
          if (list.length) out.push({ label: cat, submenu: list.map((f) => item(f.id)) });
        }
        out.push("-", { label: "Organize Filters...", run: () => void a.filterLibrary.run() }, soon("Extract...", "1.x"));
        return out;
      },
    },
    {
      title: "View",
      items: [
        a.zoomIn,
        a.zoomOut,
        a.fit,
        a.actual,
        "-",
        { label: "Screen Mode", submenu: [a.screenStandard, a.screenFullMenu, a.screenFull] },
        "-",
        a.extras,
        { label: "Show", submenu: [a.showSelection, a.showGuides, a.showGrid] },
        "-",
        a.rulers,
        "-",
        a.snap,
        "-",
        a.lockGuides,
        a.clearGuides,
        a.newGuide,
      ],
    },
    {
      title: "Window",
      items: () => {
        const names = ws.names();
        const workspaceMenu: MenuItem[] = [
          a.workspaceSave,
          a.workspaceDelete,
          a.workspaceReset,
          "-",
          a.workspaceExport,
          a.workspaceImport,
        ];
        if (names.length) {
          workspaceMenu.push("-");
          for (const n of names) workspaceMenu.push({ label: n, run: () => ws.loadNamed(n) });
        }
        const palettes: MenuItem[] = ws
          .allPalettes()
          .filter((p) => !p.soon)
          .sort((x, y) => x.title.localeCompare(y.title))
          .map((p) => {
            // F5-F9 (PS7) show in the menu.
            const fkey = ({ brushes: a.paletteBrushes, color: a.paletteColor, layers: a.paletteLayers, info: a.paletteInfo, actions: a.paletteActions } as Record<string, { shortcut?: string }>)[p.id];
            return { label: p.title, shortcut: fkey?.shortcut, checked: () => ws.isOpen(p.id) || ws.isWellOpen(p.id), run: () => ws.toggle(p.id) };
          });
        const docs: MenuItem[] = app.sessions.map((s) => ({
          label: s.doc.name + (app.sessionModified(s) ? "*" : ""),
          checked: () => app.active === s,
          run: () => app.activate(s),
        }));
        return [
          {
            label: "Arrange",
            submenu: [a.cascade, a.tile, "-", a.docFloating, a.docMaximized, "-", a.minimizeDoc, "-", a.nextDoc, a.prevDoc],
          },
          { label: "Workspace", submenu: workspaceMenu },
          {
            label: "Appearance",
            submenu: () => [
              ...themes.all().map((t) => ({ label: t.name, checked: () => themes.appearance.theme === t.id, run: () => themes.set({ theme: t.id, custom: {} }) })),
              "-" as const,
              a.appearance,
            ],
          },
          "-",
          a.toggleToolbox,
          a.toggleOptions,
          a.toggleStatus,
          a.toggleChrome,
          a.togglePalettes,
          "-",
          ...palettes,
          ...(docs.length ? (["-", ...docs] as MenuItem[]) : []),
        ];
      },
    },
    { title: "Help", items: [a.shortcuts, a.aiModels, "-", a.about] },
  ];
}
