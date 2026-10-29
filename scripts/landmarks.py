"""
Clay renders of the landmarks in site/landmarks.ts, modelled from simple
shapes at roughly true size (metres) and drawn in Rosé Pine love on a
transparent ground that keeps only their shadows.

Runs inside Blender (5.x, EEVEE), in a scene of its own so the open file is
left alone:

    exec(open('scripts/landmarks.py').read()); render_all('/path/to/repo')

or from a shell:

    blender -b -P scripts/landmarks.py -- /path/to/repo [slug ...]

Writes public/landmarks/<slug>.webp (the page's render, transparent) and
public/og/landmarks/<slug>.jpg (its share image, on the page's base colour).
LANDMARKS_PERCENT=30 renders a small preview instead and skips the share image;
LANDMARKS_OG_ONLY=1 renders only the share image.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

LOVE = '#eb6f92'
BASE = '#191724'
# The model's edges, drawn as lines over the clay: Rosé Pine's subtle neutral.
EDGE = '#908caa'
SCENE = 'Landmarks'


def linear(hex_colour):
    """sRGB hex to linear RGBA, as shader inputs take it."""
    rgb = [int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return (*lin, 1.0)


# --- Scene -------------------------------------------------------------------


def scene():
    sc = bpy.data.scenes.get(SCENE) or bpy.data.scenes.new(SCENE)
    if bpy.context.window:
        bpy.context.window.scene = sc
    return sc


def clear(sc):
    for ob in list(sc.collection.all_objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for child in list(sc.collection.children):
        bpy.data.collections.remove(child)
    for block in (bpy.data.meshes, bpy.data.lights, bpy.data.cameras):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def clay():
    mat = bpy.data.materials.get('Clay') or bpy.data.materials.new('Clay')
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = linear(LOVE)
    bsdf.inputs['Roughness'].default_value = 0.62
    return mat


def shadow_ground():
    """Transparent everywhere but in shadow: a diffuse surface's light, inverted into alpha."""
    mat = bpy.data.materials.get('Shadow') or bpy.data.materials.new('Shadow')
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    diffuse = nt.nodes.new('ShaderNodeBsdfDiffuse')
    diffuse.inputs['Color'].default_value = (1, 1, 1, 1)
    to_rgb = nt.nodes.new('ShaderNodeShaderToRGB')
    bw = nt.nodes.new('ShaderNodeRGBToBW')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    # Measured: sunlit ground reads ~0.85 here, ground in shadow ~0.24 (sky only).
    ramp.color_ramp.elements[0].position = 0.3
    ramp.color_ramp.elements[0].color = (0.6, 0.6, 0.6, 1)
    ramp.color_ramp.elements[1].position = 0.75
    ramp.color_ramp.elements[1].color = (0, 0, 0, 1)
    shade = nt.nodes.new('ShaderNodeEmission')
    shade.inputs['Color'].default_value = linear('#0e0d15')
    clear_ = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(diffuse.outputs[0], to_rgb.inputs[0])
    nt.links.new(to_rgb.outputs['Color'], bw.inputs[0])
    nt.links.new(bw.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs['Color'], mix.inputs[0])
    nt.links.new(clear_.outputs[0], mix.inputs[1])
    nt.links.new(shade.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs['Surface'])
    for attr, value in (('surface_render_method', 'BLENDED'), ('use_transparent_shadow', True)):
        try:
            setattr(mat, attr, value)
        except (AttributeError, TypeError):
            pass
    return mat


# --- Geometry helpers ----------------------------------------------------------

MAT = None
COL = None


def mesh(name, verts, faces, smooth=False):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    ob = bpy.data.objects.new(name, me)
    COL.objects.link(ob)
    ob.data.materials.append(MAT)
    return ob


def loft(name, rings, cap=True, smooth=False):
    """Closed loops of equal length, bottom to top, skinned into one solid."""
    n = len(rings[0])
    verts = [v for ring in rings for v in ring]
    faces = []
    for k in range(len(rings) - 1):
        for i in range(n):
            j = (i + 1) % n
            faces.append((k * n + i, k * n + j, (k + 1) * n + j, (k + 1) * n + i))
    if cap:
        faces.append(tuple(reversed(range(n))))
        last = (len(rings) - 1) * n
        faces.append(tuple(range(last, last + n)))
    return mesh(name, verts, faces, smooth)


def box(name, x, y, z0, sx, sy, h, rot=0.0):
    """A box centred on (x, y), sx by sy, from z0 up h, turned rot radians."""
    c, s = math.cos(rot), math.sin(rot)
    ring = lambda z: [
        (x + c * dx - s * dy, y + s * dx + c * dy, z)
        for dx, dy in ((-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2))
    ]
    return loft(name, [ring(z0), ring(z0 + h)])


def lathe(name, profile, x=0.0, y=0.0, z0=0.0, seg=48, smooth=True):
    """Spin a (radius, height) profile, bottom to top, about a vertical axis."""
    rings = [
        [
            (x + max(r, 1e-3) * math.cos(2 * math.pi * i / seg), y + max(r, 1e-3) * math.sin(2 * math.pi * i / seg), z0 + z)
            for i in range(seg)
        ]
        for r, z in profile
    ]
    return loft(name, rings, smooth=smooth)


def cylinder(name, r, z0, h, x=0.0, y=0.0, seg=32, r_top=None):
    return lathe(name, [(r, 0), (r if r_top is None else r_top, h)], x, y, z0, seg, smooth=False)


def prism(name, outline, z0, z1):
    """A vertical extrusion of a plan outline (counter-clockwise (x, y) points)."""
    return loft(name, [[(x, y, z0) for x, y in outline], [(x, y, z1) for x, y in outline]])


def pointed_arch(w, h, steps=10):
    """A pointed (two-centred) arch outline in (u, v), u across, v up, closed along the bottom."""
    half = w / 2
    spring = h - half * 1.25  # where the curve starts
    r = half * 1.6  # each arc's radius; centres sit inside the opposite jamb
    pts = [(-half, 0.0)]
    # Left arc: centred at (-half + r, spring), from the jamb up to the apex.
    cx = -half + r
    apex_angle = math.acos(cx / r)
    for i in range(steps + 1):
        a = math.pi - (math.pi - apex_angle) * i / steps
        pts.append((cx + r * math.cos(a), spring + r * math.sin(a) * (h - spring) / (r * math.sin(apex_angle))))
    for u, v in reversed(pts[1:-1]):
        pts.append((-u, v))
    pts.append((half, 0.0))
    return pts


def round_arch(w, h, steps=12):
    half = w / 2
    spring = h - half
    pts = [(-half, 0.0)]
    for i in range(steps + 1):
        a = math.pi * (1 - i / steps)
        pts.append((half * math.cos(a), spring + half * math.sin(a)))
    pts.append((half, 0.0))
    return pts


def wall_cutter(name, outline, origin, normal, depth, z0=0.0):
    """An arch (or any (u, v) outline) pushed through a wall along `normal` at `origin`."""
    n = Vector((normal[0], normal[1], 0)).normalized()
    side = Vector((-n.y, n.x, 0))
    o = Vector(origin)
    front = [o + side * u + Vector((0, 0, z0 + v)) + n * depth / 2 for u, v in outline]
    back = [p - n * depth for p in front]
    return loft(name, [back, front])


def cut(target, cutters, solver='EXACT'):
    """Subtract cutters (hidden, kept live as a boolean so nothing is applied)."""
    col = bpy.data.collections.new(f'{target.name} cuts')
    COL.children.link(col)
    for c in cutters:
        for parent in list(c.users_collection):
            parent.objects.unlink(c)
        col.objects.link(c)
        c.hide_render = True
        c.hide_viewport = True
    mod = target.modifiers.new('cuts', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'
    mod.operand_type = 'COLLECTION'
    mod.collection = col
    mod.solver = solver
    return target


def ellipse_ring(name, a, b, profile, seg=240, z0=0.0, smooth=False):
    """Sweep a closed (inset, z) profile around an ellipse with semi-axes a, b."""
    rings = []
    for d, z in profile:
        rings.append([((a - d) * math.cos(2 * math.pi * i / seg), (b - d) * math.sin(2 * math.pi * i / seg), z0 + z) for i in range(seg)])
    # Profile rings run around the section; join them into a closed tube.
    n = seg
    verts = [v for ring in rings for v in ring]
    faces = []
    for k in range(len(rings)):
        k2 = (k + 1) % len(rings)
        for i in range(n):
            j = (i + 1) % n
            faces.append((k * n + i, k * n + j, k2 * n + j, k2 * n + i))
    return mesh(name, verts, faces, smooth)


def ellipse_point(a, b, t):
    """Point and outward normal on an ellipse at parameter t."""
    p = (a * math.cos(t), b * math.sin(t))
    n = Vector((b * math.cos(t), a * math.sin(t), 0)).normalized()
    return p, n


# --- Landmarks -------------------------------------------------------------------


def eiffel_tower():
    W = lambda z: 4 + 58.5 * math.exp(-z / 80)  # half-width of the whole tower at height z
    lw = lambda z: 26 - 8.1 * min(z, 115) / 115  # one leg's width

    def leg_ring(z, sx, sy):
        w, l = W(z), min(lw(z), W(z))
        return [(sx * w, sy * w, z), (sx * (w - l), sy * w, z), (sx * (w - l), sy * (w - l), z), (sx * w, sy * (w - l), z)]

    zs = [115 * (i / 24) ** 1.0 for i in range(25)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            loft(f'Leg {sx}{sy}', [leg_ring(z, sx, sy) for z in zs])
    # Cross-bracing between the legs, every few storeys of lattice.
    for z in (22, 36, 80, 95):
        w, l = W(z), lw(z)
        for rot in range(4):
            a = rot * math.pi / 2
            box(f'Brace {z} {rot}', (w - l / 2) * math.cos(a), (w - l / 2) * math.sin(a), z, 2 * (w - l) if rot % 2 == 0 else 1.2, 1.2 if rot % 2 == 0 else 2 * (w - l), 1.4, 0)
    # The four great arches under the first floor.
    a, zs_, b = 25.0, 20.0, 37.0
    for side in range(4):
        rot = side * math.pi / 2
        rings = []
        for i in range(33):
            t = math.pi * i / 32
            x, z = a * math.cos(t), zs_ + b * math.sin(t)
            n = Vector((b * math.cos(t), 0, a * math.sin(t))).normalized()
            y = W(z) - 4
            ring = []
            for du, dv in ((-1.3, -1.3), (1.3, -1.3), (1.3, 1.3), (-1.3, 1.3)):
                p = Vector((x, y + du, z)) + n * dv
                ring.append((p.x * math.cos(rot) - p.y * math.sin(rot), p.x * math.sin(rot) + p.y * math.cos(rot), p.z))
            rings.append(ring)
        loft(f'Arch {side}', rings)
    # First floor: a square frame; second floor: solid.
    for rot in range(4):
        r = rot * math.pi / 2
        box(f'Floor 1 {rot}', 31 * math.cos(r), 31 * math.sin(r), 57, 10 if rot % 2 == 0 else 72, 72 if rot % 2 == 0 else 10, 7)
    box('Floor 2', 0, 0, 115, 42, 42, 4.5)
    # The shaft above, in two lofts with the third floor between.
    zs = [115 + (276 - 115) * i / 24 for i in range(25)]
    loft('Shaft', [[(sx * W(z), sy * W(z), z) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))] for z in zs])
    box('Floor 3', 0, 0, 274, 18, 18, 4)
    box('Lantern', 0, 0, 278, 9, 9, 12)
    lathe('Cupola', [(4.8, 0), (4.6, 3), (3.4, 6), (1.5, 8), (0.5, 9)], z0=290, seg=24)
    cylinder('Mast', 0.9, 299, 25, seg=12, r_top=0.4)


def great_pyramid():
    def pyramid(name, x, y, half, height, courses, top=None):
        top = height if top is None else top
        for k in range(courses):
            z0 = top * k / courses
            z1 = top * (k + 1) / courses
            h = half * (1 - z1 / height) + half * (0.35 / courses)
            box(f'{name} {k}', x, y, z0, 2 * h, 2 * h, z1 - z0)

    pyramid('Khufu', 0, 0, 115.2, 146.6, 64, top=138.5)
    # The three queens' pyramids along its east side.
    for i, y in enumerate((-70, -18, 34)):
        pyramid(f'Queen {i}', 150, y, 23, 30, 14)


def taj_mahal():
    ground = 6.7
    box('Plinth', 0, 0, 0, 95, 95, ground)
    half, chamfer, top = 28.5, 8.5, ground + 26
    outline = [
        (-half + chamfer, -half), (half - chamfer, -half), (half, -half + chamfer), (half, half - chamfer),
        (half - chamfer, half), (-half + chamfer, half), (-half, half - chamfer), (-half, -half + chamfer),
    ]
    body = prism('Mausoleum', outline, ground, top)
    cutters = []
    for k in range(4):
        a = k * math.pi / 2
        n = (math.cos(a), math.sin(a))
        # The great iwan on each face.
        cutters.append(wall_cutter(f'Iwan {k}', pointed_arch(14, 21), (n[0] * half, n[1] * half, ground), n, 9, 0.2))
        # Two smaller iwans, stacked, either side of it.
        side = (-n[1], n[0])
        for s in (-1, 1):
            o = (n[0] * half + side[0] * s * 10.8, n[1] * half + side[1] * s * 10.8, ground)
            for z in (1.2, 13.5):
                cutters.append(wall_cutter(f'Bay {k}{s}{z}', pointed_arch(4.6, 9.5), o, n, 4, z))
        # And on the chamfered corner beside it.
        d = a + math.pi / 4
        cn = (math.cos(d), math.sin(d))
        r = half - chamfer / 2
        o = (cn[0] * r * math.sqrt(2) * 0.995, cn[1] * r * math.sqrt(2) * 0.995, ground)
        for z in (1.2, 13.5):
            cutters.append(wall_cutter(f'Corner {k}{z}', pointed_arch(5.2, 9.5), o, cn, 4, z))
        # The pishtaq: the frame round the great iwan stands proud above the roof.
        box(f'Pishtaq {k}', n[0] * (half - 1.2), n[1] * (half - 1.2), top, 2.4 if k % 2 == 0 else 22, 22 if k % 2 == 0 else 2.4, 6.5)
    cut(body, cutters)
    # Drum and onion dome.
    cylinder('Drum', 13.2, top, 8.5, seg=48)
    R, H = 14.2, 30.0
    onion = [(1.0, 0), (1.07, 0.12), (1.12, 0.26), (1.1, 0.4), (1.0, 0.53), (0.82, 0.65), (0.6, 0.75), (0.38, 0.83),
             (0.2, 0.9), (0.09, 0.95), (0.06, 1.0), (0.0, 1.0)]
    lathe('Dome', [(R * r, H * z) for r, z in onion], z0=top + 8.5, seg=64)
    cylinder('Finial', 0.6, top + 8.5 + H - 0.5, 6, seg=12, r_top=0.15)
    lathe('Finial ball', [(0.01, 0), (1.0, 0.6), (1.0, 1.4), (0.01, 2)], z0=top + 8.5 + H + 1.5, seg=16)

    def chhatri(name, x, y, z, r):
        cylinder(f'{name} base', r * 1.15, z, r * 0.45, x, y, seg=8)
        for i in range(8):
            a = 2 * math.pi * (i + 0.5) / 8
            cylinder(f'{name} col {i}', r * 0.09, z + r * 0.45, r * 1.2, x + r * 0.9 * math.cos(a), y + r * 0.9 * math.sin(a), seg=8)
        cylinder(f'{name} eave', r * 1.25, z + r * 1.65, r * 0.18, x, y, seg=16)
        lathe(f'{name} dome', [(r * rr, r * 1.4 * zz) for rr, zz in onion], x, y, z + r * 1.83, seg=24)

    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        chhatri(f'Chhatri {k}', 16.5 * math.cos(a), 16.5 * math.sin(a), top, 3.6)
    # Minarets at the plinth's corners, each with three balconies and a chhatri.
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        x, y = 43 * (1 if math.cos(a) > 0 else -1), 43 * (1 if math.sin(a) > 0 else -1)
        cylinder(f'Minaret {k} foot', 3.6, ground, 2.5, x, y, seg=8)
        cylinder(f'Minaret {k}', 3.0, ground + 2.5, 35, x, y, seg=24, r_top=2.3)
        for j, z in enumerate((ground + 13, ground + 25, ground + 37.5)):
            cylinder(f'Minaret {k} balcony {j}', 3.9 - 0.25 * j, z, 1.1, x, y, seg=24)
        chhatri(f'Minaret {k} top', x, y, ground + 37.5, 2.6)


def colosseum():
    A, B = 94.0, 78.0  # outer wall's semi-axes
    storeys = [(0.0, 10.5), (10.5, 22.3), (22.3, 33.9)]
    attic = (33.9, 48.5)
    bays = 80
    outer = ellipse_ring('Outer wall', A, B, [(0, 0), (0, attic[1]), (4.5, attic[1]), (4.5, 0)], seg=bays * 4)
    cutters = []
    for i in range(bays):
        t = 2 * math.pi * (i + 0.5) / bays
        (x, y), n = ellipse_point(A - 2.25, B - 2.25, t)
        for z0, z1 in storeys:
            cutters.append(wall_cutter(f'Arch {i} {z0}', round_arch(4.2, (z1 - z0) * 0.72), (x, y, 0), n, 10, z0 + 0.8))
        if i % 2 == 0:
            cutters.append(wall_cutter(f'Window {i}', [(-1, 0), (-1, 2.6), (1, 2.6), (1, 0)], (x, y, 0), n, 10, attic[0] + 5))
    # The fallen south side: the outer ring is gone there, stepping down to nothing.
    for k, (half_angle, z) in enumerate(((52, -1), (60, 12), (67, 24), (73, 36))):
        mid = math.radians(270)
        span = math.radians(half_angle)
        sector = [(0.0, 0.0)] + [
            ((A + 20) * math.cos(mid - span + 2 * span * i / 24), (B + 20) * math.sin(mid - span + 2 * span * i / 24)) for i in range(25)
        ]
        cutters.append(prism(f'Ruin {k}', sector, z, 60))
    cut(outer, cutters, "MANIFOLD")
    # The second ring, seen where the outer one has fallen.
    a2, b2 = A - 12, B - 12
    inner = ellipse_ring('Second ring', a2, b2, [(0, 0), (0, 36), (3.5, 36), (3.5, 0)], seg=bays * 4)
    inner_cuts = []
    for i in range(bays):
        t = 2 * math.pi * (i + 0.5) / bays
        (x, y), n = ellipse_point(a2 - 1.75, b2 - 1.75, t)
        for z0, z1 in storeys:
            inner_cuts.append(wall_cutter(f'Inner arch {i} {z0}', round_arch(3.8, (z1 - z0) * 0.7), (x, y, 0), n, 8, z0 + 0.8))
    cut(inner, inner_cuts, "MANIFOLD")
    # Vaults between the rings, and the seating falling to the arena.
    ellipse_ring('Vaults', A - 4.5, B - 4.5, [(0, 0), (0, 30), (7.5, 30), (7.5, 0)], seg=240)
    steps = [(15.5, 31), (20, 27), (24, 23), (28, 19.5), (32, 16), (37, 12.5), (42, 9), (47, 5.5), (51, 4.0)]
    profile = [(15.4, 0), (15.4, 31)] + [p for d, z in steps[1:] for p in ((d - 4.5, z), (d, z))] + [(51, 0)]
    ellipse_ring('Cavea', A, B, profile, seg=240)
    # The arena: a stage at one end, the hypogeum's walls open to the sky elsewhere.
    a3, b3 = A - 51, B - 51
    floor = [(a3 * math.cos(2 * math.pi * i / 96), b3 * math.sin(2 * math.pi * i / 96)) for i in range(96)]
    prism('Arena', floor, -0.5, 0.2)
    prism('Stage', [(x, y) for x, y in floor if x > 18] + [(18, b3 * math.sqrt(1 - (18 / a3) ** 2) * -1)], 0.2, 4.0)
    for j in range(-5, 6):
        y = j * 4.2
        half = a3 * math.sqrt(max(0, 1 - (y / b3) ** 2)) - 1.5
        if half > 2:
            box(f'Hypogeum {j}', (min(half, 18) - half) / 2, y, 0.2, min(half, 18) + half, 0.9, 3.4)


def burj_khalifa():
    # Three wings round a hexagonal core, setting back in a spiral as it rises.
    tiers, tier_h = 27, 21.0
    reach = [70.0, 70.0, 70.0]
    for k in range(tiers):
        z0 = k * tier_h
        reach[k % 3] -= 6.6
        for i in range(3):
            if reach[i] < 18:
                continue
            a = math.radians(90 + 120 * i)
            r = reach[i] - 14
            box(f'Wing {k} {i}', r / 2 * math.cos(a), r / 2 * math.sin(a), z0, r, 28, tier_h, a)
            cylinder(f'Wing end {k} {i}', 14, z0, tier_h, r * math.cos(a), r * math.sin(a), seg=32)
    top = tiers * tier_h
    cylinder('Core', 16, 0, top, seg=6)
    # The crown: a stepped, tapering spire.
    stages = [(13, 40, 11), (11, 40, 9), (9, 36, 7.5), (7.5, 34, 6), (6, 32, 4.5), (4.5, 30, 3.2), (3.2, 34, 1.8), (1.8, 44, 0.4)]
    z = top
    for i, (r0, h, r1) in enumerate(stages):
        cylinder(f'Spire {i}', r0, z, h, seg=6 if i < 3 else 16, r_top=r1)
        z += h
    # Its podium.
    cylinder('Podium', 76, -6, 6, seg=3)


def sydney_opera_house():
    P = 10.0  # the podium's height
    box('Podium', 0, 0, 0, 100, 160, P)
    # The monumental steps on the land side.
    for i in range(10):
        box(f'Step {i}', 0, -80 - 3 * i, 0, 96, 3.2, P * (1 - i / 10))

    def shell(name, x, y, facing, length, height, width, lean=0.35):
        """A sail: a pointed arch at its open end, sweeping back down to a point."""
        d = Vector((0, facing, 0))
        side = Vector((1, 0, 0))
        nu, nv = 16, 20
        surface = []
        for i in range(nu + 1):
            s = i / nu
            h = height * math.sin(s * math.pi / 2) ** 0.9
            b = width / 2 * (0.25 + 0.75 * s ** 0.6)
            row = []
            for j in range(nv + 1):
                t = -1 + 2 * j / nv
                z = h * (1 - abs(t)) ** 0.62
                p = Vector((x, y, P)) + d * (s * length + lean * z * s) + side * (t * b) + Vector((0, 0, z))
                row.append(p)
            surface.append(row)
        verts = [p for row in surface for p in row]
        faces = []
        for i in range(nu):
            for j in range(nv):
                a = i * (nv + 1) + j
                faces.append((a, a + 1, a + nv + 2, a + nv + 1))
        ob = mesh(name, verts, faces, smooth=True)
        mod = ob.modifiers.new('thickness', 'SOLIDIFY')
        mod.thickness = 1.6
        mod.offset = -1
        # The glass wall under the open arch, set back a little.
        front = surface[-1]
        inset = d * -2.5
        glass = [p + inset for p in front]
        mesh(f'{name} glass', glass, [tuple(range(len(glass)))])
        return ob

    rows = [
        # (x, row scale): the Concert Hall, east, and the Joan Sutherland Theatre, west.
        (24, 1.0),
        (-27, 0.86),
    ]
    for x, k in rows:
        shell(f'Shell {x} back', x, -14 * k, -1, 34 * k, 38 * k, 40 * k, lean=0.2)
        shell(f'Shell {x} a', x, -42 * k, 1, 56 * k, 67 * k, 46 * k)
        shell(f'Shell {x} b', x, -6 * k, 1, 44 * k, 54 * k, 40 * k)
        shell(f'Shell {x} c', x, 20 * k, 1, 34 * k, 40 * k, 32 * k)
    # The restaurant's pair, on its own by the steps.
    shell('Restaurant a', -42, -70, -1, 14, 18, 18, lean=0.2)
    shell('Restaurant b', -42, -82, 1, 18, 22, 20)


# slug: (builder, camera azimuth°, elevation°, resolution (w, h))
LANDMARKS = {
    'eiffel-tower': (eiffel_tower, 35, 12, (1200, 1600)),
    'great-pyramid-of-giza': (great_pyramid, 32, 20, (1600, 1200)),
    'taj-mahal': (taj_mahal, 24, 14, (1600, 1200)),
    'colosseum': (colosseum, 200, 32, (1600, 1200)),
    'burj-khalifa': (burj_khalifa, 30, 10, (1000, 1600)),
    'sydney-opera-house': (sydney_opera_house, 130, 22, (1600, 1200)),
}


# --- Lighting, camera, render ---------------------------------------------------

SUN = 3.2
SUN_ELEVATION = 48
SKY = 1.0


def setup(sc, res):
    try:
        sc.render.engine = 'BLENDER_EEVEE_NEXT'
    except TypeError:
        sc.render.engine = 'BLENDER_EEVEE'
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = int(os.environ.get('LANDMARKS_PERCENT', 100))
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    sc.view_settings.look = 'None'
    sc.eevee.taa_render_samples = 64
    for attr, value in (('use_raytracing', True), ('use_shadows', True), ('shadow_ray_count', 2), ('shadow_step_count', 8)):
        if hasattr(sc.eevee, attr):
            setattr(sc.eevee, attr, value)
    edges(sc)
    world = sc.world or bpy.data.worlds.new('Landmarks')
    sc.world = world
    world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = linear('#6e6a86')
    bg.inputs['Strength'].default_value = SKY


def edges(sc):
    """Freestyle lines along the model's outline and creases (not smooth curves, not the ground)."""
    sc.render.use_freestyle = True
    sc.render.line_thickness_mode = 'ABSOLUTE'
    sc.render.line_thickness = sc.render.resolution_percentage / 100
    fs = sc.view_layers[0].freestyle_settings
    fs.crease_angle = math.radians(140)
    ls = fs.linesets[0] if len(fs.linesets) else fs.linesets.new('Edges')
    ls.select_by_visibility = True
    ls.visibility = 'VISIBLE'
    ls.select_by_edge_types = True
    ls.select_silhouette = ls.select_border = ls.select_crease = True
    ls.select_by_collection = True
    ls.collection = COL
    ls.linestyle.color = linear(EDGE)[:3]
    ls.linestyle.thickness = 1.2
    ls.linestyle.alpha = 0.9


def light(sc, azimuth):
    sun = bpy.data.lights.new('Sun', 'SUN')
    sun.energy = SUN
    sun.angle = math.radians(4)
    sun.color = linear('#fff4e8')[:3]
    ob = bpy.data.objects.new('Sun', sun)
    # From the camera's left and above, so faces turn and shadows fall forward-right.
    ob.rotation_euler = (math.radians(90 - SUN_ELEVATION), 0, math.radians(azimuth - 55 + 90))
    sc.collection.objects.link(ob)


def frame(sc, azimuth, elevation, objects, margin=0.9):
    """Aim a camera from (azimuth, elevation) and back it off until every object fits."""
    pts = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    centre = (lo + hi) / 2
    az, el = math.radians(azimuth), math.radians(elevation)
    d = Vector((math.cos(el) * math.sin(az), -math.cos(el) * math.cos(az), math.sin(el)))
    forward = -d
    right = forward.cross(Vector((0, 0, 1))).normalized()
    up = right.cross(forward)
    cam = bpy.data.cameras.new('Camera')
    cam.lens = 70
    cam.sensor_fit = 'AUTO'
    w, h = sc.render.resolution_x, sc.render.resolution_y
    tan_wide = cam.sensor_width / 2 / cam.lens
    tan_x, tan_y = (tan_wide, tan_wide * h / w) if w >= h else (tan_wide * w / h, tan_wide)
    dist = 0.0
    for p in pts:
        q = p - centre
        depth = q.dot(d)
        dist = max(dist, depth + abs(q.dot(right)) / (tan_x * margin), depth + abs(q.dot(up)) / (tan_y * margin))
    cam.clip_end = dist * 4
    cam.clip_start = dist / 200
    ob = bpy.data.objects.new('Camera', cam)
    ob.location = centre + d * dist
    ob.rotation_euler = forward.to_track_quat('-Z', 'Y').to_euler()
    sc.collection.objects.link(ob)
    sc.camera = ob
    return lo


def build(slug):
    global MAT, COL
    builder, azimuth, elevation, res = LANDMARKS[slug]
    sc = scene()
    clear(sc)
    COL = bpy.data.collections.new(slug)
    sc.collection.children.link(COL)
    MAT = clay()
    builder()
    setup(sc, res)
    shown = [o for o in COL.all_objects if not o.hide_render]
    lo = frame(sc, azimuth, elevation, shown)
    light(sc, azimuth)
    size = max(sc.camera.location.length, 1000) * 3
    ground = mesh('Ground', [(-size, -size, lo.z), (size, -size, lo.z), (size, size, lo.z), (-size, size, lo.z)], [(0, 1, 2, 3)])
    ground.data.materials[0] = shadow_ground()
    # Outside the landmark's collection, so it draws no lines.
    COL.objects.unlink(ground)
    sc.collection.objects.link(ground)
    return sc


def render(slug, root):
    sc = build(slug)
    if os.environ.get('LANDMARKS_OG_ONLY'):
        return og(sc, slug, root)
    out = os.path.join(root, 'public', 'landmarks', f'{slug}.webp')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sc.render.image_settings.file_format = 'WEBP'
    sc.render.image_settings.color_mode = 'RGBA'
    sc.render.image_settings.quality = 88
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True, scene=sc.name)
    if not os.environ.get('LANDMARKS_PERCENT'):
        og(sc, slug, root)
    return out


def og(sc, slug, root):
    """The share image: 1200×630 on the page's base colour, framed again for its shape."""
    _, azimuth, elevation, _ = LANDMARKS[slug]
    sc.render.resolution_x, sc.render.resolution_y = 1200, 630
    sc.render.film_transparent = False
    page_camera = sc.camera
    frame(sc, azimuth, elevation, [o for o in COL.all_objects if not o.hide_render and o.name != 'Ground'], margin=0.84)
    bpy.data.objects.remove(page_camera, do_unlink=True)
    world = sc.world.node_tree
    bg = next(n for n in world.nodes if n.type == 'BACKGROUND')
    # The camera sees the page's colour; everything else still sees the sky.
    path = next((n for n in world.nodes if n.type == 'LIGHT_PATH'), None) or world.nodes.new('ShaderNodeLightPath')
    plain = next((n for n in world.nodes if n.name == 'Page'), None) or world.nodes.new('ShaderNodeBackground')
    plain.name = 'Page'
    plain.inputs['Color'].default_value = linear(BASE)
    mix = next((n for n in world.nodes if n.type == 'MIX_SHADER'), None) or world.nodes.new('ShaderNodeMixShader')
    out = next(n for n in world.nodes if n.type == 'OUTPUT_WORLD')
    world.links.new(path.outputs['Is Camera Ray'], mix.inputs[0])
    world.links.new(bg.outputs[0], mix.inputs[1])
    world.links.new(plain.outputs[0], mix.inputs[2])
    world.links.new(mix.outputs[0], out.inputs['Surface'])
    target = os.path.join(root, 'public', 'og', 'landmarks', f'{slug}.jpg')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    sc.render.image_settings.file_format = 'JPEG'
    sc.render.image_settings.color_mode = 'RGB'
    sc.render.image_settings.quality = 86
    sc.render.filepath = target
    bpy.ops.render.render(write_still=True, scene=sc.name)
    return target


def render_all(root, slugs=None):
    for slug in slugs or LANDMARKS:
        print('rendered', render(slug, root))


if __name__ == '__main__' and '--' in sys.argv:
    args = sys.argv[sys.argv.index('--') + 1 :]
    render_all(args[0], args[1:] or None)
