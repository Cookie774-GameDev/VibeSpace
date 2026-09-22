"""Map the canonical Axolotl source layers into stable runtime roles.

The manifest is the authority for layer order, visibility, branding, and source
file paths.  This module only adds the small runtime grouping needed by the
pixel rig; it does not rewrite the manifest or derive new source assets.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from .extract_palette import map_rgb_to_palette


_RUNTIME_ROLE_IDS: dict[str, tuple[str, ...]] = {
    "body": (
        "left_string_tip",
        "right_string_tip",
        "left_hoodie_string",
        "right_hoodie_string",
        "zipper_or_center_detail",
        "hoodie_bottom_trim",
        "left_pocket_trim",
        "right_pocket_trim",
        "hoodie_pocket",
        "hoodie_highlights",
        "hoodie_shadows",
        "front_highlights",
        "front_shadows",
        "hoodie_torso",
        "body_base",
        "hoodie_torso_residual_cleanup",
        "body_base_residual_cleanup",
    ),
    "helmet": (
        "left_side_module",
        "right_side_module",
        "helmet_peach_trim",
        "head_base",
        "helmet_highlights",
        "helmet_shadows",
        "helmet_shell",
        "helmet_shell_residual_cleanup",
    ),
    "face-screen": ("face_screen_highlight", "face_screen_base"),
    "left-arm": ("left_upper_arm", "left_forearm"),
    "right-arm": ("right_upper_arm", "right_forearm"),
    "left-hand": ("left_hand",),
    "right-hand": ("right_hand",),
    "left-leg": ("left_leg",),
    "right-leg": ("right_leg",),
    "left-foot": ("left_foot",),
    "right-foot": ("right_foot",),
    "tail": ("tail_back",),
    "left-gill-lower": ("left_gills_back_lower",),
    "left-gill-middle": ("left_gills_back_middle",),
    "left-gill-upper": ("left_gills_back_upper",),
    "right-gill-lower": ("right_gills_back_lower",),
    "right-gill-middle": ("right_gills_back_middle",),
    "right-gill-upper": ("right_gills_back_upper",),
    "head-logo": ("head_v_logo", "head_logo_badge"),
    "chest-logo": ("chest_v_logo", "chest_logo_badge"),
}

_UNDERLAP_IDS = (
    "helmet_back",
    "tail_root_underlap",
    "left_gill_upper_attachment",
    "left_gill_middle_attachment",
    "left_gill_lower_attachment",
    "right_gill_upper_attachment",
    "right_gill_middle_attachment",
    "right_gill_lower_attachment",
    "left_leg_underlap",
    "right_leg_underlap",
    "left_upper_arm_underlap",
    "right_upper_arm_underlap",
    "left_hand_underlap",
    "right_hand_underlap",
    "helmet_under_face_trim",
    "torso_behind_arms",
    "lower_body_behind_hoodie",
)

_BASE_HAPPY_IDS = (
    "left_eye",
    "right_eye",
    "mouth",
    "tongue_or_inner_mouth",
)


def _layer_index(manifest: Mapping[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    layers = manifest.get("layers")
    if not isinstance(layers, list) or not layers:
        raise ValueError("manifest.layers must be a non-empty list")

    by_id: dict[str, dict[str, Any]] = {}
    for layer in layers:
        if not isinstance(layer, dict) or not isinstance(layer.get("id"), str):
            raise ValueError("every manifest layer must have a string id")
        layer_id = layer["id"]
        if layer_id in by_id:
            raise ValueError(f"duplicate manifest layer id: {layer_id}")
        by_id[layer_id] = layer

    declared_order = manifest.get("layerOrder")
    if declared_order is None:
        order = [layer["id"] for layer in layers]
    elif isinstance(declared_order, list) and all(isinstance(item, str) for item in declared_order):
        order = list(declared_order)
    else:
        raise ValueError("manifest.layerOrder must be a list of strings")

    if len(order) != len(by_id) or set(order) != set(by_id):
        raise ValueError("manifest.layerOrder must contain each layer exactly once")
    return by_id, order


def _ordered(ids: Iterable[str], order_index: Mapping[str, int]) -> list[str]:
    return sorted(ids, key=order_index.__getitem__)


def _entry(
    ids: Iterable[str],
    by_id: Mapping[str, Mapping[str, Any]],
) -> dict[str, Any]:
    source_ids = list(ids)
    if not source_ids:
        raise ValueError("runtime layer groups cannot be empty")
    return {
        "sourceLayerIds": source_ids,
        "mirrorAllowed": all(bool(by_id[layer_id].get("mirrorAllowed", True)) for layer_id in source_ids),
    }


def build_source_layer_map(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Build the deterministic runtime grouping for one source manifest.

    Every source layer is assigned once to a runtime role, expression,
    underlap, effect, or archival-only bucket.  Failing closed here prevents a
    future manifest change from silently dropping a layer from the rig.
    """

    by_id, order = _layer_index(manifest)
    order_index = {layer_id: index for index, layer_id in enumerate(order)}
    assigned: dict[str, str] = {}

    def claim(layer_ids: Iterable[str], bucket: str) -> list[str]:
        layer_ids = list(layer_ids)
        for layer_id in layer_ids:
            if layer_id not in by_id:
                raise ValueError(f"mapping references unknown layer: {layer_id}")
        ordered_ids = _ordered(layer_ids, order_index)
        for layer_id in ordered_ids:
            if layer_id not in by_id:
                raise ValueError(f"mapping references unknown layer: {layer_id}")
            previous = assigned.get(layer_id)
            if previous is not None:
                raise ValueError(f"layer {layer_id} assigned to both {previous} and {bucket}")
            assigned[layer_id] = bucket
        return ordered_ids

    runtime_roles: dict[str, dict[str, Any]] = {}
    for role, layer_ids in _RUNTIME_ROLE_IDS.items():
        runtime_roles[role] = _entry(claim(layer_ids, f"runtimeRoles.{role}"), by_id)

    expression_names = manifest.get("expressions", {}).get("names", [])
    if not isinstance(expression_names, list) or not all(isinstance(name, str) for name in expression_names):
        raise ValueError("manifest.expressions.names must be a list of strings")

    expressions: dict[str, dict[str, Any]] = {}
    for name in expression_names:
        expression_ids = [
            layer_id
            for layer_id in by_id
            if layer_id.startswith(f"{name}__")
        ]
        if name == "happy":
            expression_ids.extend(_BASE_HAPPY_IDS)
        if expression_ids:
            ordered_ids = claim(expression_ids, f"expressions.{name}")
            expressions[name] = _entry(ordered_ids, by_id)

    underlaps: dict[str, dict[str, Any]] = {}
    for layer_id in claim(_UNDERLAP_IDS, "underlaps"):
        underlaps[layer_id] = _entry([layer_id], by_id)

    effect_ids = [
        layer_id
        for layer_id, layer in by_id.items()
        if layer.get("group") in {"01_BACK_EFFECTS", "10_EFFECTS"}
    ]
    effects: dict[str, dict[str, Any]] = {}
    for layer_id in claim(effect_ids, "effects"):
        effects[layer_id] = _entry([layer_id], by_id)

    archival_ids = [
        layer_id
        for layer_id, layer in by_id.items()
        if layer.get("group") in {"00_GUIDES", "11_REFERENCE"}
    ]
    archival_only = claim(archival_ids, "archivalOnlyLayerIds")

    unassigned = [layer_id for layer_id in order if layer_id not in assigned]
    if unassigned:
        raise ValueError(f"manifest layers are not mapped: {', '.join(unassigned)}")

    return {
        "schemaVersion": 1,
        "characterId": manifest.get("characterId"),
        "canvas": manifest.get("canvas"),
        "layerOrder": order,
        "runtimeRoles": runtime_roles,
        "expressions": expressions,
        "underlaps": underlaps,
        "effects": effects,
        "archivalOnlyLayerIds": archival_only,
    }


def render_runtime_role(
    role: str,
    mapping: Mapping[str, Any],
    manifest: Mapping[str, Any],
    character_root: Path,
    *,
    scale: int = 1,
    palette: list[tuple[int, int, int]] | None = None,
) -> Image.Image:
    """Composite one runtime role into a nearest-neighbour pixel image.

    Source layers are full-canvas PNGs, so no inferred crop or geometry is
    introduced.  When a palette is supplied, only visible pixels are mapped;
    transparent pixels keep their RGB values irrelevant and are made fully
    transparent.  The resulting alpha is always hard 0/255 for native-pixel
    assets.
    """

    if not isinstance(scale, int) or isinstance(scale, bool) or scale <= 0:
        raise ValueError("scale must be a positive integer")
    runtime_roles = mapping.get("runtimeRoles")
    if not isinstance(runtime_roles, Mapping) or role not in runtime_roles:
        raise KeyError(f"unknown runtime role: {role}")
    entry = runtime_roles[role]
    source_ids = entry.get("sourceLayerIds") if isinstance(entry, Mapping) else None
    if not isinstance(source_ids, list) or not source_ids:
        raise ValueError(f"runtime role has no source layers: {role}")

    by_id, _ = _layer_index(manifest)
    canvas = manifest.get("canvas")
    if not isinstance(canvas, Mapping):
        raise ValueError("manifest.canvas must be an object")
    try:
        width = int(canvas["width"])
        height = int(canvas["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("manifest.canvas must contain integer width and height") from exc
    if width <= 0 or height <= 0 or width % scale or height % scale:
        raise ValueError("canvas dimensions must be positive and divisible by scale")

    composed = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    root = Path(character_root).resolve()
    for layer_id in source_ids:
        layer = by_id.get(layer_id)
        if layer is None:
            raise ValueError(f"runtime role references unknown manifest layer: {layer_id}")
        relative_file = layer.get("file")
        if not isinstance(relative_file, str) or not relative_file:
            raise ValueError(f"layer has no source file: {layer_id}")
        path = (root / relative_file).resolve()
        if not path.is_relative_to(root):
            raise ValueError(f"layer source escapes character root: {layer_id}")
        with Image.open(path) as image:
            source = image.convert("RGBA")
        if source.size != composed.size:
            raise ValueError(
                f"layer {layer_id} is {source.size}, expected {composed.size}"
            )
        composed = Image.alpha_composite(composed, source)

    reduced = composed.resize((width // scale, height // scale), Image.Resampling.NEAREST)
    rgba = np.asarray(reduced, dtype=np.uint8).copy()
    visible = rgba[:, :, 3] > 0
    if palette is not None:
        mapped_rgb = map_rgb_to_palette(rgba[:, :, :3], palette)
        rgba[:, :, :3] = np.where(visible[:, :, None], mapped_rgb, rgba[:, :, :3])
    rgba[:, :, 3] = np.where(visible, 255, 0).astype(np.uint8)
    return Image.fromarray(rgba)
