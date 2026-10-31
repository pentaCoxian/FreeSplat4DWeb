"""
Business card generator for ぺんたこしあん (pentacoxian_dev).

Builds both sides as SVG (mm units, 3 mm bleed), lays out text in Chromium so
measurements use the real fonts, then exports:
  print/  — 2-page print PDF (bleed), PDF with Japanese-style crop marks (トンボ)
  editable/ — front.svg / back.svg (open in Illustrator), layered PSDs (Photoshop)
  preview/ — 350 dpi PNGs and a mockup image

Card: 91 x 55 mm (Japanese standard 名刺), bleed 3 mm -> document 97 x 61 mm.
Usage: python build_card.py <assets_dir> <out_dir> [--name-font mincho|sans]
"""
import argparse, base64, json, os, pathlib

import segno
from playwright.sync_api import sync_playwright

TRIM_W, TRIM_H, BLEED = 91.0, 55.0, 3.0
DOC_W, DOC_H = TRIM_W + 2 * BLEED, TRIM_H + 2 * BLEED
DPI = 350

C = {
    "ivory": "#F4EFE6",
    "linen": "#E8E1D5",
    "tile": "#FAF7F1",
    "line": "#D2C9BB",
    "gray": "#86807A",
    "charcoal": "#3A3634",
    "bordeaux": "#6B3440",
    "bordeaux_soft": "#A57A80",
    "qr": "#2E2A2A",
}

CONTENT = {
    "name_ja": "ぺんたこしあん",
    "handle": "pentacoxian_dev",
    "work_label": "WORK",
    "work_title": "Intern",
    "work_detail": "Full-scratch 4DGS system development",
    "study_label": "STUDY",
    "study_title": "International Christian University",
    "study_detail": "国際基督教大学 (ICU) — Student",
    "focus_label": "FOCUS",
    "focus": [
        "Local AI Fine-tuning",
        "LLM Optimization",
        "Gaussian Splatting / 4D",
        "Computer Vision / ML",
        "Full-stack Web",
    ],
    "links": [
        ("GitHub", "https://github.com/pentaCoxian", "github.com/pentaCoxian"),
        ("Hugging Face", "https://huggingface.co/pentaCoxian", "huggingface.co/pentaCoxian"),
    ],
}

SANS = "'IBM Plex Sans JP', sans-serif"
MONO = "'IBM Plex Mono', monospace"
MINCHO = "'Shippori Mincho B1', serif"


def data_uri(path, mime):
    return f"data:{mime};base64," + base64.b64encode(pathlib.Path(path).read_bytes()).decode()


def qr_path(url, x, y, size):
    """QR code as a single SVG path (merged horizontal runs), no quiet zone drawn."""
    qr = segno.make(url, version=3, error="m", boost_error=True)
    rows = [list(r) for r in qr.matrix]
    n = len(rows)
    m = size / n
    d = []
    for j, row in enumerate(rows):
        i = 0
        while i < n:
            if row[i]:
                k = i
                while k < n and row[k]:
                    k += 1
                d.append(f"M{x + i * m:.4f} {y + j * m:.4f}h{(k - i) * m:.4f}v{m:.4f}h{-(k - i) * m:.4f}z")
                i = k
            else:
                i += 1
    return "".join(d), qr.version, qr.error, n


def text(x, y, s, size, family, weight=400, fill=None, ls=0.0, anchor="start", extra=""):
    fill = fill or C["charcoal"]
    ls_attr = f' letter-spacing="{ls}"' if ls else ""
    return (f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
            f'fill="{fill}" text-anchor="{anchor}"{ls_attr} {extra}>{s}</text>')


def svg_open(layer_id):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'id="{layer_id}" width="{DOC_W}mm" height="{DOC_H}mm" viewBox="0 0 {DOC_W} {DOC_H}">')


def front_svg(assets, name_font):
    av = data_uri(assets / "avatar_linen.png", "image/png")
    T = f'transform="translate({BLEED} {BLEED})"'
    # avatar crop: source px circle centre (620, 640), radius 600 of a 1254 px square
    cx, cy, r = 17.0, 19.5, 11.6
    s = r / 600.0
    ix, iy, iw = cx - 620 * s, cy - 640 * s, 1254 * s
    name_family = MINCHO if name_font == "mincho" else SANS
    name_weight = 600 if name_font == "mincho" else 600

    tx = 36.0  # text column (trim coords)
    vx = 47.0  # value column
    out = [svg_open("front")]
    out.append('<defs><clipPath id="avatarClip"><circle cx="%s" cy="%s" r="%s"/></clipPath></defs>' % (cx + BLEED, cy + BLEED, r))
    # --- layer: background
    out.append(f'<g id="Background">'
               f'<rect x="0" y="0" width="{DOC_W}" height="{DOC_H}" fill="{C["ivory"]}"/>'
               f'<rect x="0" y="{BLEED + 38.2}" width="{DOC_W}" height="{DOC_H - BLEED - 38.2}" fill="{C["linen"]}"/>'
               f'<rect x="0" y="{BLEED + 38.2}" width="{DOC_W}" height="0.18" fill="{C["line"]}"/>'
               f'<rect x="0" y="0" width="{BLEED + 2.4}" height="{BLEED + 38.2}" fill="{C["bordeaux"]}"/>'
               f'</g>')
    # --- layer: avatar
    out.append(f'<g id="Avatar">'
               f'<circle cx="{cx + BLEED}" cy="{cy + BLEED}" r="{r + 0.9}" fill="none" stroke="{C["bordeaux"]}" stroke-width="0.25"/>'
               f'<image clip-path="url(#avatarClip)" x="{ix + BLEED:.4f}" y="{iy + BLEED:.4f}" width="{iw:.4f}" height="{iw:.4f}" '
               f'preserveAspectRatio="xMidYMid slice" href="{av}" xlink:href="{av}"/>'
               f'</g>')
    # --- layer: identity + details
    g = [f'<g id="Text" {T}>']
    g.append(text(tx, 11.6, CONTENT["name_ja"], 4.7, name_family, name_weight, C["charcoal"], 0.12))
    g.append(text(tx, 16.1, CONTENT["handle"], 2.15, MONO, 400, C["gray"], 0.12))
    g.append(f'<rect x="{tx}" y="18.4" width="7" height="0.28" fill="{C["bordeaux"]}"/>')
    rows = [
        (22.9, CONTENT["work_label"], CONTENT["work_title"], CONTENT["work_detail"]),
        (30.2, CONTENT["study_label"], CONTENT["study_title"], CONTENT["study_detail"]),
    ]
    for y, lab, title, detail in rows:
        g.append(text(tx, y - 0.15, lab, 1.55, MONO, 500, C["bordeaux"], 0.32))
        g.append(text(vx, y, title, 2.25, SANS, 600, C["charcoal"], 0.02, extra='class="fit"'))
        g.append(text(vx, y + 3.0, detail, 1.95, SANS, 400, C["gray"], 0.02, extra='class="fit"'))
    g.append('</g>')
    out.append("".join(g))
    # --- layer: focus tags (laid out in the browser)
    tags = "".join(
        f'<g class="tag"><rect rx="1.8" ry="1.8" fill="{C["tile"]}" stroke="{C["bordeaux_soft"]}" stroke-width="0.16"/>'
        + text(0, 0, t, 1.85, SANS, 500, C["charcoal"], 0.03) + '</g>'
        for t in CONTENT["focus"])
    out.append(f'<g id="Focus" {T} data-x0="7.0" data-x1="86.0" data-y0="43.4">'
               + text(7.0, 41.7, CONTENT["focus_label"], 1.55, MONO, 500, C["bordeaux"], 0.32)
               + tags + '</g>')
    out.append('</svg>')
    return "".join(out)


def back_svg(assets):
    logo = data_uri(assets / "logo_wordmark.png", "image/png")
    T = f'transform="translate({BLEED} {BLEED})"'
    out = [svg_open("back")]
    out.append(f'<g id="Background">'
               f'<rect x="0" y="0" width="{DOC_W}" height="{DOC_H}" fill="{C["linen"]}"/>'
               f'<rect x="{DOC_W - BLEED - 2.4}" y="0" width="{BLEED + 2.4}" height="{DOC_H}" fill="{C["bordeaux"]}"/>'
               f'</g>')
    # QR block geometry (trim coords); right edge kept 2 mm clear of the bordeaux bar
    q = 14.6           # module area (29 modules -> ~0.5 mm/module)
    pad = 1.9          # light margin inside the tile; linen outside continues the quiet zone
    tile = q + 2 * pad
    gap = 3.0
    right = 86.4
    x0 = right - 2 * tile - gap
    block_h = tile + 9.6
    ty = (TRIM_H - block_h) / 2
    div_x = x0 - 3.4
    # logo: 1311 x 597 px, centred in the space left of the divider
    lw = 35.0
    lh = lw * 597 / 1311
    lx = (div_x - lw) / 2 + 0.4
    ly = (TRIM_H - lh) / 2
    out.append(f'<g id="Logo" {T}><image x="{lx:.4f}" y="{ly:.4f}" width="{lw}" height="{lh:.4f}" href="{logo}" xlink:href="{logo}"/></g>')
    out.append(f'<g id="Divider" {T}><rect x="{div_x:.4f}" y="{ty - 1.5:.4f}" width="0.16" height="{block_h + 3:.4f}" fill="{C["line"]}"/></g>')
    g = [f'<g id="QR" {T}>']
    meta = []
    for k, (label, url, short) in enumerate(CONTENT["links"]):
        tx = x0 + k * (tile + gap)
        g.append(f'<rect x="{tx:.4f}" y="{ty:.4f}" width="{tile:.4f}" height="{tile:.4f}" rx="1.2" fill="{C["tile"]}" stroke="{C["line"]}" stroke-width="0.16"/>')
        d, ver, err, n = qr_path(url, tx + pad, ty + pad, q)
        meta.append({"url": url, "version": ver, "error": err, "modules": n, "module_mm": round(q / n, 3)})
        g.append(f'<path d="{d}" fill="{C["qr"]}"/>')
        cxl = round(tx + tile / 2, 4)
        g.append(text(cxl, round(ty + tile + 3.9, 4), label.upper(), 1.55, MONO, 500, C["bordeaux"], 0.32, "middle"))
        host, path = short.split("/", 1)
        g.append(text(cxl, round(ty + tile + 6.8, 4), host + "/", 1.5, MONO, 400, C["gray"], 0.04, "middle"))
        g.append(text(cxl, round(ty + tile + 9.0, 4), path, 1.5, MONO, 400, C["gray"], 0.04, "middle"))
    g.append('</g>')
    out.append("".join(g))
    out.append('</svg>')
    return "".join(out), meta


LAYOUT_JS = r"""
() => {
  const report = {};
  // focus tags: flow into rows
  const f = document.querySelector('#front #Focus');
  const x0 = +f.dataset.x0, x1 = +f.dataset.x1, y0 = +f.dataset.y0;
  const padX = 1.45, h = 3.5, gapX = 1.3, gapY = 1.15;
  let x = x0, y = y0; const rows = [[]];
  for (const g of f.querySelectorAll('.tag')) {
    const t = g.querySelector('text'), r = g.querySelector('rect');
    const w = t.getComputedTextLength() + 2 * padX;
    if (x + w > x1 + 1e-6 && x > x0) { x = x0; y += h + gapY; rows.push([]); }
    r.setAttribute('x', x.toFixed(3)); r.setAttribute('y', y.toFixed(3));
    r.setAttribute('width', w.toFixed(3)); r.setAttribute('height', h);
    t.setAttribute('x', (x + padX).toFixed(3)); t.setAttribute('y', (y + h / 2 + 0.64).toFixed(3));
    rows[rows.length - 1].push(t.textContent);
    x += w + gapX;
  }
  report.tagRows = rows; report.tagBottom = y + h;
  // overflow check for the text column (trim right edge minus 4 mm safe margin = 87)
  report.overflow = [];
  for (const t of document.querySelectorAll('#front .fit')) {
    const right = +t.getAttribute('x') + t.getComputedTextLength();
    if (right > 87) report.overflow.push([t.textContent, right.toFixed(2)]);
  }
  return report;
}
"""


FONT_FILES = {  # family -> {weight: file}
    "IBM Plex Sans JP": {400: "IBMPlexSansJP-400.ttf", 500: "IBMPlexSansJP-500.ttf", 600: "IBMPlexSansJP-600.ttf", 700: "IBMPlexSansJP-700.ttf"},
    "IBM Plex Mono": {400: "IBMPlexMono-400.ttf", 500: "IBMPlexMono-500.ttf"},
    "Shippori Mincho B1": {600: "ShipporiMinchoB1-600.ttf", 700: "ShipporiMinchoB1-700.ttf"},
}
FONT_CSS = ""


def font_css(font_dir):
    rules = []
    for fam, weights in FONT_FILES.items():
        for w, f in weights.items():
            rules.append(f"@font-face {{ font-family: '{fam}'; font-weight: {w}; font-style: normal; "
                         f"src: url('{(pathlib.Path(font_dir) / f).resolve().as_uri()}') format('truetype'); }}")
    return "\n".join(rules)


def page_html(body, w_mm, h_mm, bg="transparent"):
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
{FONT_CSS}
@page {{ size: {w_mm}mm {h_mm}mm; margin: 0 }}
html,body {{ margin:0; padding:0; background:{bg} }}
.page {{ width:{w_mm}mm; height:{h_mm}mm; position:relative; overflow:hidden; break-after:page; page-break-after:always }}
.page:last-child {{ break-after:auto; page-break-after:auto }}
svg {{ display:block }}
</style></head><body>{body}</body></html>"""


def crop_marks_svg(card_svg, margin=12.0):
    """Wrap a bleed-size card in a larger page with Japanese-style double corner + centre trim marks."""
    W, H = DOC_W + 2 * margin, DOC_H + 2 * margin
    tl, tt = margin + BLEED, margin + BLEED            # trim box
    tr, tb = tl + TRIM_W, tt + TRIM_H
    bl, bt, br, bb = margin, margin, margin + DOC_W, margin + DOC_H  # bleed box
    L = 9.0
    sw = 0.1
    lines = []
    for (xt, xb, sx) in ((tl, bl, -1), (tr, br, 1)):
        for (yt, yb, sy) in ((tt, bt, -1), (tb, bb, 1)):
            # horizontal marks (outside left/right): at trim y and bleed y
            ex = xb + sx * L
            lines += [(xb, yt, ex, yt), (xt, yb, ex, yb)]
            ey = yb + sy * L
            lines += [(xt, yb, xt, ey), (xb, yt, xb, ey)]
    # centre marks
    mx, my = (tl + tr) / 2, (tt + tb) / 2
    for y in (bt - 1.0, bb + 1.0):
        lines += [(mx - 5, y, mx + 5, y)]
        lines += [(mx, y - 3 if y < bt else y - 3, mx, y + 3)]
    for x in (bl - 1.0, br + 1.0):
        lines += [(x, my - 5, x, my + 5)]
        lines += [(x - 3, my, x + 3, my)]
    marks = "".join(f'<line x1="{a:.3f}" y1="{b:.3f}" x2="{c:.3f}" y2="{d:.3f}"/>' for a, b, c, d in lines)
    inner = card_svg.replace(f'width="{DOC_W}mm" height="{DOC_H}mm"', f'x="{margin}" y="{margin}" width="{DOC_W}" height="{DOC_H}"', 1)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="{W}mm" height="{H}mm" viewBox="0 0 {W} {H}">'
            f'<rect width="{W}" height="{H}" fill="#fff"/>{inner}'
            f'<g fill="none" stroke="#000" stroke-width="{sw}">{marks}</g></svg>'), W, H


def finalize_pdf(path, w_mm, h_mm, trim_inset_mm, bleed_inset_mm):
    """Re-seat Chromium's pages on an exact-size MediaBox and declare BleedBox/TrimBox."""
    import pymupdf
    pt = 72 / 25.4
    src = pymupdf.open(path)
    dst = pymupdf.open()
    W, H = w_mm * pt, h_mm * pt
    for i, sp in enumerate(src):
        np_ = dst.new_page(width=W, height=H)
        np_.show_pdf_page(pymupdf.Rect(0, 0, sp.rect.width, sp.rect.height), src, i, clip=None)
        t, b = trim_inset_mm * pt, bleed_inset_mm * pt
        dst.xref_set_key(np_.xref, "BleedBox", f"[{b:.4f} {b:.4f} {W - b:.4f} {H - b:.4f}]")
        dst.xref_set_key(np_.xref, "TrimBox", f"[{t:.4f} {t:.4f} {W - t:.4f} {H - t:.4f}]")
    dst.set_metadata({"title": "Business card — ぺんたこしあん (pentacoxian_dev)", "author": "pentacoxian_dev",
                      "subject": f"91 x 55 mm card, 3 mm bleed", "creator": "build_card.py"})
    src.close()
    dst.save(path + ".tmp", garbage=3, deflate=True)
    dst.close()
    os.replace(path + ".tmp", path)


PX_W = round(DOC_W / 25.4 * DPI)   # 1337 px
PX_H = round(DOC_H / 25.4 * DPI)   # 841 px


def shoot(page, side, path, transparent=False):
    from PIL import Image
    page.evaluate("""(side) => { document.querySelectorAll('.page').forEach(d =>
        d.style.display = d.querySelector('svg').id === side ? 'block' : 'none'); }""", side)
    page.screenshot(path=str(path), clip={"x": 0, "y": 0, "width": DOC_W * 96 / 25.4, "height": DOC_H * 96 / 25.4},
                    omit_background=transparent)
    im = Image.open(path)
    im = im.crop((0, 0, PX_W, PX_H)) if im.size != (PX_W, PX_H) else im
    im.save(path, dpi=(DPI, DPI))
    page.evaluate("() => document.querySelectorAll('.page').forEach(d => d.style.display = '')")


LAYERS = {"front": ["Background", "Avatar", "Text", "Focus"], "back": ["Background", "Logo", "Divider", "QR"]}


def export_psd_layers(page, out):
    """Screenshot each top-level group alone (transparent) and stack them into a layered PSD."""
    from PIL import Image
    from psd_tools import PSDImage
    from psd_tools.constants import Resource
    from psd_tools.psd.image_resources import ImageResource, ResoulutionInfo
    for side, groups in LAYERS.items():
        shots = {}
        for gid in groups:
            page.evaluate("""([side, gid]) => {
                for (const g of document.querySelectorAll(`#${side} > g`)) g.style.visibility = (g.id === gid) ? 'visible' : 'hidden';
            }""", [side, gid])
            f = out / f"work/layer_{side}_{gid}.png"
            shoot(page, side, f, transparent=True)
            shots[gid] = Image.open(f).convert("RGBA")
        page.evaluate("""(side) => { for (const g of document.querySelectorAll(`#${side} > g`)) g.style.visibility = ''; }""", side)
        size = shots[groups[0]].size
        psd = PSDImage.new("RGB", size)
        for gid in groups:
            psd.create_pixel_layer(shots[gid], name=gid) if hasattr(psd, "create_pixel_layer") else None
        res = ResoulutionInfo(horizontal=DPI << 16, horizontal_unit=1, width_unit=2,
                              vertical=DPI << 16, vertical_unit=1, height_unit=2)
        psd._record.image_resources[Resource.RESOLUTION_INFO] = ImageResource(key=Resource.RESOLUTION_INFO.value, data=res)
        psd.save(str(out / f"editable/{side}_layers_350dpi.psd"))


def mockup(out):
    """Both sides on a neutral surface, for a quick look (not for print)."""
    from PIL import Image, ImageFilter
    f = Image.open(out / "preview/front.png").convert("RGBA")
    b = Image.open(out / "preview/back.png").convert("RGBA")
    k = 0.62
    f = f.resize((int(f.width * k), int(f.height * k)), Image.LANCZOS)
    b = b.resize(f.size, Image.LANCZOS)
    W, H = int(f.width * 2.36), int(f.height * 1.7)
    bg = Image.new("RGBA", (W, H), (207, 202, 194, 255))
    def place(card, cx, cy, angle):
        ss = 3  # supersample the rotation for clean edges
        big = card.resize((card.width * ss, card.height * ss), Image.LANCZOS)
        c = big.rotate(angle, resample=Image.BICUBIC, expand=True)
        c = c.resize((c.width // ss, c.height // ss), Image.LANCZOS)
        x, y = cx - c.width // 2, cy - c.height // 2
        pad = 60
        m = Image.new("L", (c.width + 2 * pad, c.height + 2 * pad), 0)
        m.paste(c.getchannel("A"), (pad, pad))
        m = m.filter(ImageFilter.GaussianBlur(16)).point(lambda v: int(v * 0.30))
        shadow = Image.new("RGBA", m.size, (40, 32, 30, 255)); shadow.putalpha(m)
        bg.alpha_composite(shadow, (x - pad + 5, y - pad + 13))
        bg.alpha_composite(c, (x, y))
    place(f, int(W * 0.255), int(H * 0.5), 1.2)
    place(b, int(W * 0.745), int(H * 0.49), -1.6)
    bg.convert("RGB").save(out / "preview/mockup.jpg", quality=92)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assets"); ap.add_argument("out")
    ap.add_argument("--name-font", default="mincho", choices=["mincho", "sans"])
    ap.add_argument("--preview-only", action="store_true")
    ap.add_argument("--fonts", default=str(pathlib.Path(__file__).resolve().parent.parent / "fonts"),
                    help="folder with the TTFs listed in FONT_FILES (see README)")
    a = ap.parse_args()
    global FONT_CSS
    FONT_CSS = font_css(a.fonts)
    assets, out = pathlib.Path(a.assets), pathlib.Path(a.out)
    for sub in ("print", "editable", "preview", "work"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    front = front_svg(assets, a.name_font)
    back, qr_meta = back_svg(assets)
    px_per_mm = 96 / 25.4
    scale = DPI / 96

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None, args=["--no-sandbox"])
        ctx = browser.new_context(device_scale_factor=scale,
                                  viewport={"width": int(DOC_W * px_per_mm) + 2, "height": int(DOC_H * px_per_mm * 2) + 4})
        page = ctx.new_page()
        html = page_html(f'<div class="page">{front}</div><div class="page">{back}</div>', DOC_W, DOC_H)
        (out / "work/layout.html").write_text(html, encoding="utf-8")
        page.goto((out / "work/layout.html").resolve().as_uri())
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(300)
        report = page.evaluate(LAYOUT_JS)
        report["qr"] = qr_meta
        print(json.dumps(report, ensure_ascii=False, indent=1))
        # serialize laid-out SVGs
        front_final = page.evaluate("document.querySelector('#front').outerHTML")
        back_final = page.evaluate("document.querySelector('#back').outerHTML")
        hdr = '<?xml version="1.0" encoding="UTF-8"?>\n'
        (out / "editable/front.svg").write_text(hdr + front_final, encoding="utf-8")
        (out / "editable/back.svg").write_text(hdr + back_final, encoding="utf-8")

        # previews (350 dpi, with bleed) + trimmed previews
        for side in ("front", "back"):
            shoot(page, side, out / f"work/{side}_bleed.png")

        if not a.preview_only:
            # print PDF (bleed size)
            final_html = page_html(f'<div class="page">{front_final}</div><div class="page">{back_final}</div>', DOC_W, DOC_H)
            (out / "work/print.html").write_text(final_html, encoding="utf-8")
            page.goto((out / "work/print.html").resolve().as_uri())
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(out / "print/pentacoxian_card_print.pdf"), width=f"{DOC_W}mm", height=f"{DOC_H}mm",
                     print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
            export_psd_layers(page, out)
            # crop-mark PDF
            cf, W, H = crop_marks_svg(front_final)
            cb, _, _ = crop_marks_svg(back_final)
            cm_html = page_html(f'<div class="page">{cf}</div><div class="page">{cb}</div>', W, H, "#fff")
            (out / "work/cropmarks.html").write_text(cm_html, encoding="utf-8")
            page.goto((out / "work/cropmarks.html").resolve().as_uri())
            page.evaluate("document.fonts.ready")
            page.pdf(path=str(out / "print/pentacoxian_card_print_trim-marks.pdf"), width=f"{W}mm", height=f"{H}mm",
                     print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
        browser.close()
    if not a.preview_only:
        finalize_pdf(str(out / "print/pentacoxian_card_print.pdf"), DOC_W, DOC_H, BLEED, 0)
        finalize_pdf(str(out / "print/pentacoxian_card_print_trim-marks.pdf"), W, H, 12 + BLEED, 12)

    # trimmed previews
    from PIL import Image
    for side in ("front", "back"):
        im = Image.open(out / f"work/{side}_bleed.png")
        b = round(BLEED / 25.4 * DPI)
        im.crop((b, b, im.width - b, im.height - b)).save(out / f"preview/{side}.png", dpi=(DPI, DPI))
        im.save(out / f"preview/{side}_with-bleed.png", dpi=(DPI, DPI))
    (out / "work/report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1))
    mockup(out)


if __name__ == "__main__":
    main()
