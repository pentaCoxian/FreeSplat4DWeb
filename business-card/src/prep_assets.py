import sys, numpy as np, cv2
from PIL import Image, ImageDraw
src, out = sys.argv[1], sys.argv[2]
import os; os.makedirs(out, exist_ok=True)

# ---------- Logo: remove the outer white background (keep the sticker's own white) ----------
im = np.array(Image.open(f"{src}/logo.png").convert("RGB")).astype(np.float32)
lum = im.mean(axis=2)
h, w = lum.shape
near_white = (lum > 248).astype(np.uint8)
# flood fill from the border: only white connected to the image edge is background
n, lab = cv2.connectedComponents(near_white, connectivity=4)
edge_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
bg = np.isin(lab, list(edge_labels))
# anti-aliased fringe: pixels within 3px of background, un-mix from white over the outline gray
dist = cv2.distanceTransform((~bg).astype(np.uint8), cv2.DIST_L2, 3)
fringe = (~bg) & (dist <= 3)
outline = 78.0  # the sticker's dark-gray outline
alpha = np.ones((h, w), np.float32)
alpha[bg] = 0
a = np.clip((255 - lum) / (255 - outline), 0, 1)
alpha[fringe] = a[fringe]
rgb = im.copy()
rgb[fringe] = outline  # fringe colour = outline gray, coverage carried by alpha
rgba = np.dstack([rgb, alpha * 255]).astype(np.uint8)
ys, xs = np.where(alpha > 0.01)
pad = 6
crop = rgba[max(ys.min()-pad,0):ys.max()+pad, max(xs.min()-pad,0):xs.max()+pad]
Image.fromarray(crop, "RGBA").save(f"{out}/logo_wordmark.png")
print("logo", crop.shape)

# ---------- Avatar: replace the flat white backdrop with a soft linen tone, square crop ----------
av = np.array(Image.open(f"{src}/avatar.webp").convert("RGB")).astype(np.float32)
L = av.mean(axis=2); sat = av.max(axis=2) - av.min(axis=2)
cand = ((L > 244) & (sat < 10)).astype(np.uint8)
n, lab = cv2.connectedComponents(cand, connectivity=4)
H, W = L.shape
edge_labels = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
bgm = np.isin(lab, list(edge_labels))
# soften the boundary so the line-art edge blends into the new tone
soft = cv2.GaussianBlur(bgm.astype(np.float32), (0, 0), 1.2)
tone = np.array([233, 226, 213], np.float32)  # linen
# blend: where background, recolour by multiplying (keeps any faint texture)
rec = av * (tone / 253.0)
outav = av * (1 - soft[..., None]) + rec * soft[..., None]
Image.fromarray(np.clip(outav, 0, 255).astype(np.uint8)).save(f"{out}/avatar_linen.png")
Image.fromarray(av.astype(np.uint8)).save(f"{out}/avatar_original.png")
print("avatar bg fraction", bgm.mean())
