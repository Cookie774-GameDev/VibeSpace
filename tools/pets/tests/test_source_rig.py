import json
from pathlib import Path
import sys

import numpy as np
import pytest
from PIL import Image


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pets_pipeline.extract_palette import extract_palette
from pets_pipeline.map_source_layers import build_source_layer_map, render_runtime_role


CHARACTER_ROOT = (
    REPO_ROOT
    / "grok"
    / "pets"
    / "input"
    / "characters"
    / "vibespace-axolotl-pixel"
)
MANIFEST = json.loads(
    (CHARACTER_ROOT / "archival" / "vibespace_axolotl_layer_manifest.json").read_text(
        encoding="utf-8"
    )
)


def test_source_layer_map_rejects_missing_required_layer() -> None:
    manifest = json.loads(json.dumps(MANIFEST))
    manifest['layers'] = [layer for layer in manifest['layers'] if layer['id'] != 'left_hand']
    manifest['layerOrder'] = [layer for layer in manifest['layerOrder'] if layer != 'left_hand']
    with pytest.raises(ValueError, match='unknown layer: left_hand'):
        build_source_layer_map(manifest)


def test_runtime_layer_cannot_read_outside_character_root(tmp_path: Path) -> None:
    manifest = json.loads(json.dumps(MANIFEST))
    mapping = build_source_layer_map(manifest)
    for layer in manifest['layers']:
        if layer['id'] == 'left_hand':
            layer['file'] = '../private.png'
    with pytest.raises(ValueError, match='escapes character root'):
        render_runtime_role('left-hand', mapping, manifest, tmp_path)


def test_source_layer_map_accounts_for_every_source_layer_once() -> None:
    mapping = build_source_layer_map(MANIFEST)

    assert set(mapping["runtimeRoles"]) == {
        "body",
        "helmet",
        "face-screen",
        "left-arm",
        "right-arm",
        "left-hand",
        "right-hand",
        "left-leg",
        "right-leg",
        "left-foot",
        "right-foot",
        "tail",
        "left-gill-lower",
        "left-gill-middle",
        "left-gill-upper",
        "right-gill-lower",
        "right-gill-middle",
        "right-gill-upper",
        "head-logo",
        "chest-logo",
    }
    assert mapping["runtimeRoles"]["head-logo"]["mirrorAllowed"] is False
    assert mapping["runtimeRoles"]["chest-logo"]["mirrorAllowed"] is False
    assigned = []
    for category in (
        mapping["runtimeRoles"].values(),
        mapping["expressions"].values(),
        mapping["underlaps"].values(),
        mapping["effects"].values(),
    ):
        for entry in category:
            assigned.extend(entry["sourceLayerIds"])
    assigned.extend(mapping["archivalOnlyLayerIds"])
    assert len(assigned) == len(set(assigned)) == 136
    assert set(assigned) == {layer["id"] for layer in MANIFEST["layers"]}


def test_render_runtime_role_is_native_hard_alpha_and_palette_bounded() -> None:
    mapping = build_source_layer_map(MANIFEST)
    source = Image.open(
        CHARACTER_ROOT / "previews" / "vibespace_axolotl_preview_transparent.png"
    ).convert("RGBA")
    palette = extract_palette(source, max_colors=32)

    body = render_runtime_role(
        "body",
        mapping,
        MANIFEST,
        CHARACTER_ROOT,
        scale=6,
        palette=palette,
    )

    array = np.asarray(body)
    assert body.size == (209, 209)
    assert set(np.unique(array[:, :, 3])) <= {0, 255}
    assert np.count_nonzero(array[:, :, 3]) > 0
    assert set(map(tuple, array[array[:, :, 3] == 255, :3])) <= set(palette)
