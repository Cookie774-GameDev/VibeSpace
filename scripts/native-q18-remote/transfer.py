"""Granted CI488 staging only. Streaming, bounded, no product execution."""
import argparse
import hashlib
import json
import os
import posixpath
import ntpath
import re
from artifact_dll_checks import inspect_closure
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = None  # Set only by explicit runner CLI; import is side-effect free.
SOURCE = "8579072d21e6a994b3c95f44997922997679324a"
RUN = "36842581937"
CHUNK = 1024 * 1024
MAX_EXPANDED = 2 * 1024**3
MAX_CENTRAL = 4 * 1024**2
MAX_FILES = 10000
MAX_JSON = 8 * 1024**2
ARTIFACTS = {
    "build": (11153265092, 777743318, "fe3ea024e7968dde73745dcde8cc733004093685a41014bbe7e7a1c28477969c"),
    "evidence": (11152409776, 631339, "6030ec5109ddc34d915563146400c4972e6a1b0aec840c23c74640f52ee9678c"),
}
REPO = "Cookie774-GameDev/VibeSpace"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None



def fixed_api(endpoint):
    token = os.environ.get('GITHUB_TOKEN', '')
    require(token, 'ephemeral_runner_actions_token_required')
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
               'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'FRESH2NS01-fixed-artifact-consumer'}
    require(endpoint.startswith(f'https://api.github.com/repos/{REPO}/actions/'), 'fixed_api_route')
    return urllib.request.Request(endpoint, headers=headers)

def authorized_artifact_url(kind):
    opener = urllib.request.build_opener(NoRedirect)
    with opener.open(fixed_api(f'https://api.github.com/repos/{REPO}/actions/runs/{RUN}'), timeout=60) as response:
        body = response.read(MAX_JSON + 1)
    require(len(body) <= MAX_JSON, 'run_metadata_budget')
    run = json.loads(body)
    require(run.get('id') == int(RUN) and run.get('head_sha') == SOURCE and run.get('status') == 'completed' and run.get('conclusion') == 'success', 'successful_exact_run_required')
    artifact_id, size, sha = ARTIFACTS[kind]
    endpoint = f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}'
    with opener.open(fixed_api(endpoint), timeout=60) as response:
        body = response.read(MAX_JSON + 1)
    require(len(body) <= MAX_JSON, 'artifact_metadata_budget')
    metadata = json.loads(body)
    verify_metadata(kind, metadata)
    try:
        response = opener.open(fixed_api(endpoint + '/zip'), timeout=60)
    except urllib.error.HTTPError as error:
        require(error.code == 302, 'artifact_redirect_required')
        response = error
    with response:
        require(response.code == 302, 'artifact_redirect_required')
        address = response.headers.get('Location', '')
    require(urllib.parse.urlsplit(address).scheme == 'https', 'https_artifact_redirect_required')
    # The separate download request has NO Authorization header.
    return address

def verify_metadata(kind, metadata):
    artifact_id, size, sha = ARTIFACTS[kind]
    endpoint = f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}'
    require(metadata.get('id') == artifact_id and metadata.get('expired') is False, 'artifact_identity_expiry')
    require(metadata.get('size_in_bytes') == size and metadata.get('digest') == 'sha256:' + sha, 'artifact_metadata_changed')
    require(metadata.get('workflow_run', {}).get('id') == int(RUN) and metadata.get('workflow_run', {}).get('head_sha') == SOURCE, 'artifact_source_run_mismatch')
    require(metadata.get('archive_download_url') == endpoint + '/zip', 'artifact_endpoint_mismatch')
    return True

def require(condition, label):
    if not condition:
        raise ValueError(label)


def digest(file):
    value = hashlib.sha256()
    with open(file, "rb") as stream:
        while block := stream.read(CHUNK):
            value.update(block)
    return value.hexdigest()


def save(name, value):
    with open(ROOT / name, "x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def disk_gate():
    archive_bytes = sum(info[1] for info in ARTIFACTS.values())
    # 25% disk estimate allowance plus 1 GiB remaining reserve.
    required = (archive_bytes + MAX_EXPANDED + 16 * 1024**2) * 5 // 4 + 1024**3
    free = shutil.disk_usage(ROOT).free
    require(free >= required, "disk_admission_failed")
    return {"availableBytes": free, "requiredBytes": required}


def download(kind):
    require(os.environ.get("FRESH2_ARTIFACT_GRANT_ID"), "explicit_root_grant_required")
    artifact_id, expected_size, expected_digest = ARTIFACTS[kind]
    destination = ROOT / (kind + ".zip")
    require(not destination.exists(), "refuse_existing_archive")
    capacity = disk_gate()
    address = authorized_artifact_url(kind)
    actual = 0
    value = hashlib.sha256()
    started = time.time()
    with urllib.request.urlopen(address, timeout=60) as response:
        require(response.status == 200, "http_success_required")
        require(urllib.parse.urlsplit(response.url).scheme == "https", "https_redirect_required")
        with open(destination, "xb") as output:
            while block := response.read(CHUNK):
                actual += len(block)
                require(actual <= expected_size, "archive_size_budget_exceeded")
                require(time.time() - started <= 1800, "download_deadline_exceeded")
                value.update(block)
                output.write(block)
    require(actual == expected_size, "archive_size_mismatch")
    require(value.hexdigest() == expected_digest, "archive_digest_mismatch")
    save(kind + "-download.json", {"artifactId": artifact_id, "bytes": actual,
         "archiveSHA256": value.hexdigest(), "disk": capacity, "sourceSHA": SOURCE,
         "runId": RUN, "grantId": os.environ["FRESH2_ARTIFACT_GRANT_ID"]})


def safe_name(name):
    require(0 < len(name) <= 512 and "\\" not in name and "\x00" not in name, "invalid_zip_name")
    require(not name.startswith("/"), "absolute_zip_path")
    parts = name.rstrip("/").split("/")
    reserved = {"con", "prn", "aux", "nul"} | {f"{p}{n}" for p in ("com", "lpt") for n in range(1, 10)}
    for part in parts:
        require(part not in ("", ".", "..") and not any(c in part for c in ':<>"|?*'), "unsafe_zip_component")
        require(part == part.rstrip(" .") and part.split(".")[0].casefold() not in reserved, "windows_alias_path")
    return PurePosixPath(*parts)


def bounded_directory(archive):
    # Reject oversized metadata before ZipFile allocates its central directory.
    with open(archive, "rb") as stream:
        stream.seek(max(0, archive.stat().st_size - 65557))
        tail = stream.read(65557)
    offset = tail.rfind(b"PK\x05\x06")
    require(offset >= 0 and len(tail) >= offset + 22, "missing_zip_end_record")
    end = struct.unpack_from("<4s4H2IH", tail, offset)
    require(end[1] == end[2] == 0 and end[3] == end[4], "multi_disk_zip_refused")
    require(end[4] <= MAX_FILES and end[5] <= MAX_CENTRAL, "zip_metadata_budget_exceeded")
    require(end[4] != 65535 and end[5] != 0xFFFFFFFF, "zip64_not_needed_for_bounded_artifact")


def extract(kind):
    require(os.environ.get("FRESH2_ARTIFACT_GRANT_ID"), "explicit_root_grant_required")
    archive = ROOT / (kind + ".zip")
    require(archive.is_file() and not archive.is_symlink(), "regular_archive_required")
    artifact_id, expected_size, expected_digest = ARTIFACTS[kind]
    require(archive.stat().st_size == expected_size and digest(archive) == expected_digest, "archive_identity_mismatch")
    bounded_directory(archive)
    output = ROOT / kind
    require(not output.exists(), "refuse_existing_extraction")
    capacity = disk_gate()
    with zipfile.ZipFile(archive) as container:
        entries = container.infolist()
        require(len(entries) <= MAX_FILES, "entry_budget_exceeded")
        total = sum(entry.file_size for entry in entries)
        # Both archives share one 2 GiB extraction reservation.
        previous = ROOT / ("evidence-extract.json" if kind == "build" else "build-extract.json")
        previous_bytes = json_file(previous)["uncompressedBytes"] if previous.exists() else 0
        require(total + previous_bytes <= MAX_EXPANDED, "expanded_size_budget_exceeded")
        names = set()
        for entry in entries:
            name = str(safe_name(entry.filename))
            require(name.casefold() not in names, "duplicate_or_case_alias_zip_path")
            names.add(name.casefold())
            require(not entry.flag_bits & 1 and entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED), "unsupported_zip_encoding")
            mode = entry.external_attr >> 16
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR), "special_zip_entry_refused")
            require(entry.file_size <= 1024**3, "single_file_budget_exceeded")
        output.mkdir()
        for entry in entries:
            destination = output.joinpath(*safe_name(entry.filename).parts)
            if entry.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            count = 0
            with container.open(entry) as source, open(destination, "xb") as sink:
                while block := source.read(CHUNK):
                    count += len(block)
                    require(count <= entry.file_size, "expanded_entry_size_exceeded")
                    sink.write(block)
            require(count == entry.file_size, "expanded_entry_size_mismatch")
    save(kind + "-extract.json", {"artifactId": artifact_id, "uncompressedBytes": total,
         "entryCount": len(entries), "disk": capacity, "sourceSHA": SOURCE})


def json_file(file):
    require(file.is_file() and not file.is_symlink() and file.stat().st_size <= MAX_JSON, "bounded_json_required")
    return json.loads(file.read_text(encoding="utf-8-sig"))


def pe(file):
    with open(file, "rb") as stream:
        header = stream.read(64)
        require(len(header) == 64 and header[:2] == b"MZ", "invalid_dos_header")
        offset = struct.unpack_from("<I", header, 60)[0]
        require(offset + 24 <= file.stat().st_size, "invalid_pe_offset")
        stream.seek(offset)
        header = stream.read(24)
    require(header[:4] == b"PE\x00\x00", "invalid_pe_signature")
    require(struct.unpack_from("<H", header, 4)[0] == 0x8664, "amd64_required")
    flags = struct.unpack_from("<H", header, 22)[0]
    require(flags & 2, "pe_executable_image_required")
    return {"isDLL": bool(flags & 0x2000), "bytes": file.stat().st_size, "sha256": digest(file)}


def inspect():
    build = ROOT / "build"
    evidence = ROOT / "evidence"
    manifest = json_file(build / "artifact-manifest.json")
    provenance = json_file(build / "provenance.json")
    inputs = json_file(build / "input-manifest.json")
    require(provenance["sourceCommitSHA"] == SOURCE and str(provenance["runId"]) == RUN, "source_run_mismatch")
    require(provenance["cargoLockSHA256"] == "85e0635a34f9c21b521b727d646b5433b6fb1b22ef5a345caf1fba94f5df7592", "lock_mismatch")
    require(provenance["windowsConfigSHA256"] == "2c6209c5daefe31f25eb23b40c45601d896accb2066dd338efae1f8a624d6790", "config_mismatch")
    require(provenance["connectorSourceSHA256"] == "3ef1b27c5fab49c1fcfda65cac522d4061b7557a884f5c811dfaee76ebbfe9af", "connector_mismatch")
    require(provenance["features"] == ["default", "jarvis-voice"] and provenance["target"] == "x86_64-pc-windows-msvc", "target_features_mismatch")
    require("rustc 1.96.0" in provenance["rustc"], "toolchain_mismatch")
    expected = {"artifact-manifest.json"}
    for item in manifest["files"] + manifest["evidenceFiles"]:
        name = str(safe_name(item["path"]))
        require(name not in expected, "duplicate_manifest_path")
        expected.add(name)
        file = build.joinpath(*safe_name(name).parts)
        require(file.is_file() and not file.is_symlink() and file.stat().st_size == item["bytes"], "manifest_size_type_mismatch")
        require(digest(file) == item["sha256"], "manifest_digest_mismatch")
    actual = {file.relative_to(build).as_posix() for file in build.rglob("*") if file.is_file()}
    require(expected == actual, "artifact_file_closure_mismatch")
    for name in ("input-manifest.json", "provenance.json", "dll-dependencies.txt", "dll-inventory.json"):
        require(digest(build / name) == digest(evidence / name), "packaged_diagnostic_identity_mismatch")
    value = hashlib.sha256(json.dumps(inputs["files"], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    require(value == inputs["sha256"] == provenance["inputSHA256"], "input_manifest_identity_mismatch")
    frozen = {item["path"]: item["sha256"] for item in inputs["files"]}
    payload_names = {item["path"] for item in manifest["files"]}
    payload = []
    for item in manifest["files"]:
        require(item["path"].startswith("binary/"), "payload_prefix_required")
        relative = item["path"][7:]
        payload.append({"path": relative, "bytes": item["bytes"], "sha256": item["sha256"]})
        if relative.startswith(("resources/", "_up_/")):
            source_name = posixpath.normpath("app/src-tauri/" + relative.replace("_up_", ".."))
            require(frozen.get(source_name) == item["sha256"], "frozen_resource_mismatch")
    payload_digest = hashlib.sha256(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    require(payload_digest == manifest["payloadSHA256"], "payload_manifest_digest_mismatch")
    for name in frozen:
        if name.startswith(("app/src-tauri/resources/desktop-connector/", "app/src-tauri/resources/siyuan-runtime/")):
            require("binary/" + name[len("app/src-tauri/"):] in payload_names, "missing_frozen_resource")
    connector = build / "binary/resources/desktop-connector"
    connector_manifest = json_file(connector / "manifest.json")
    require(connector_manifest["platform"] == "win32-x64", "connector_platform_mismatch")
    require(digest(connector / "runtime.zip") == connector_manifest["sha256"], "connector_runtime_digest_mismatch")
    require((build / "binary/resources/siyuan-runtime/VIBESPACE_SIYUAN_READY.json").is_file(), "siyuan_ready_record_missing")
    binary = build / "binary" / "jarvis.exe"
    executable = pe(binary)
    require(not executable["isDLL"], "product_exe_is_dll")
    require(executable["sha256"] == provenance["build"]["output"]["sha256"], "build_output_identity_mismatch")
    child = provenance["build"]["cargo"]
    require(child["code"] == 0 and child["signal"] is None and child["spawnError"] is None, "real_build_child_not_successful")
    require(child["command"] == "cargo" and child["args"] == ["build", "--manifest-path", "app/src-tauri/Cargo.toml", "--bin", "jarvis", "--features", "jarvis-voice", "--locked", "-j", "1"], "build_argv_mismatch")
    dlls = {}
    for file in (build / "binary").glob("*.dll"):
        dlls[file.name] = pe(file)
        require(dlls[file.name]["isDLL"], "dll_pe_flag_mismatch")
    require((build / "dll-dependencies.txt").stat().st_size > 0, "missing_dependency_report")
    closure = inspect_closure(build, evidence, provenance, manifest, executable, dlls, SOURCE, require, json_file, digest, pe)
    save("inspection.json", {"sourceSHA": SOURCE, "runId": RUN, "archiveIdentities": ARTIFACTS,
         "exe": executable, "topLevelDLLs": dlls, "verifiedDLLClosure": closure, "payloadFileCount": len(manifest["files"]),
         "provenanceSHA256": digest(build / "provenance.json"),
         "inputManifestSHA256": digest(build / "input-manifest.json"),
         "payloadSHA256": payload_digest,
         "dllReportSHA256": digest(build / "dll-dependencies.txt"),
         "nativeAcceptance": "UNRUN", "systemDLLAndWebView2Resolution": "UNRUN",
         "rustUnitTests": "UNRUN", "launchInstallPhysicalExeReplacement": False})



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('download', 'extract', 'inspect'))
    parser.add_argument('--kind', choices=tuple(ARTIFACTS))
    parser.add_argument('--staging', required=True)
    parser.add_argument('--grant-id', required=True)
    args = parser.parse_args()
    try:
        require(os.environ.get('GITHUB_ACTIONS') == 'true', 'future_runner_only')
        require(re.fullmatch(r'ROOT[A-Za-z0-9_-]{4,128}', args.grant_id), 'explicit_root_grant')
        native = Path(args.staging).absolute()
        runner = Path(os.environ['RUNNER_TEMP']).resolve()
        require(native.is_relative_to(runner) and native != runner and native.is_dir() and not native.is_symlink(), 'owned_runner_staging_required')
        ROOT = Path('\\\\?\\' + str(native))
        os.environ['FRESH2_ARTIFACT_GRANT_ID'] = args.grant_id
        if args.operation == 'inspect':
            inspect()
        else:
            require(args.kind, 'artifact_kind_required')
            globals()[args.operation](args.kind)
        print(json.dumps({'operation': args.operation, 'kind': args.kind, 'pid': os.getpid(), 'status': 'PASS'}))
    except Exception as error:
        label = str(error) if type(error) is ValueError and re.fullmatch(r'[a-z0-9_]{1,80}', str(error)) else type(error).__name__        print(json.dumps({'operation': args.operation, 'kind': args.kind, 'pid': os.getpid(), 'status': 'FAIL', 'reason': label}))
        sys.exit(1)
