import ntpath
import re
import struct

SYSTEM = {n + '.dll' for n in ('kernel32 ntdll kernelbase user32 gdi32 gdi32full advapi32 ole32 oleaut32 shell32 shlwapi combase comctl32 crypt32 cryptbase bcrypt bcryptprimitives ws2_32 setupapi cfgmgr32 dbghelp dwmapi dxgi d3d12 d3d11 dxcore dcomp dwrite imm32 shcore propsys version wintrust secur32 sspicli normaliz uxtheme winmm winhttp wininet urlmon psapi iphlpapi netapi32 ntmarta win32u wtsapi32 powrprof pdh ucrtbase rpcrt4 mswsock').split()}

def normalized(path):
    return ntpath.normcase(ntpath.normpath(path))

def within(root, path):
    root, path = normalized(root), normalized(path)
    return path != root and ntpath.commonpath([root, path]) == root

def pe_imports(file, require):
    """Read actual direct/delay PE imports with bounded table/name allocations."""
    size = file.stat().st_size
    with open(file, 'rb') as stream:
        def read(offset, count):
            require(0 <= offset <= size and 0 <= count <= 65536 and offset + count <= size, 'pe_read_bounds')
            stream.seek(offset)
            data = stream.read(count)
            require(len(data) == count, 'pe_short_read')
            return data
        dos = read(0, 64)
        base = struct.unpack_from('<I', dos, 60)[0]
        header = read(base, 24)
        sections, optional_size = struct.unpack_from('<H', header, 6)[0], struct.unpack_from('<H', header, 20)[0]
        require(0 < sections <= 96 and 112 <= optional_size <= 4096, 'pe_header_budget')
        optional = read(base + 24, optional_size)
        require(struct.unpack_from('<H', optional)[0] == 0x20b, 'pe32plus_required')
        image_base = struct.unpack_from('<Q', optional, 24)[0]
        directory_count = struct.unpack_from('<I', optional, 108)[0]
        require(directory_count <= 16 and 112 + directory_count * 8 <= optional_size, 'pe_directory_bounds')
        raw = read(base + 24 + optional_size, sections * 40)
        mappings = []
        for index in range(sections):
            virtual_size, rva, raw_size, offset = struct.unpack_from('<4I', raw, index * 40 + 8)
            mappings.append((rva, raw_size, offset))
        def locate(rva, count):
            matches = [offset + rva - start for start, length, offset in mappings if start <= rva and rva + count <= start + length]
            require(len(matches) == 1, 'pe_rva_mapping')
            return matches[0]
        def name(rva):
            data = bytearray()
            for index in range(512):
                value = read(locate(rva + index, 1), 1)
                if value == b'\x00':
                    result = data.decode('ascii').lower()
                    require(re.fullmatch(r'[a-z0-9_.-]+\.dll', result), 'pe_import_name')
                    return result
                data.extend(value)
            require(False, 'pe_import_name_budget')
        imports = set()
        for directory, width, name_index in ((1, 20, 3), (13, 32, 1)):
            if directory >= directory_count:
                continue
            rva, length = struct.unpack_from('<2I', optional, 112 + directory * 8)
            if rva == 0:
                continue
            require(width <= length <= 1024 * 1024, 'pe_import_table_budget')
            terminated = False
            for index in range(min(length // width, 4096)):
                values = struct.unpack('<' + 'I' * (width // 4), read(locate(rva + index * width, width), width))
                if not any(values):
                    terminated = True
                    break
                name_rva = values[name_index]
                if directory == 13 and not values[0] & 1:
                    name_rva -= image_base
                imports.add(name(name_rva))
            require(terminated, 'pe_import_table_termination')
        return sorted(imports)

def inspect_closure(build, evidence, provenance, manifest, executable, dlls, source, require, json_file, digest, pe):
    inventory = json_file(build / 'dll-inventory.json')
    inventory_sha = digest(build / 'dll-inventory.json')
    require(inventory['sourceSHA'] == source and inventory['executableSHA256'] == executable['sha256'], 'dll_inventory_source_exe')
    require(provenance['dllInventorySHA256'] == inventory_sha, 'dll_inventory_provenance')
    target = inventory['target']
    target_root = ntpath.dirname(target)
    require(normalized(inventory['ortCache']) == normalized(ntpath.join(target_root, 'ort-cache')), 'ort_cache_root')
    require(re.search(r'/VC/Redist/MSVC/[^/]+/x64/Microsoft\.VC\d+\.CRT$', inventory['msvcRedistRoot'].replace('\\', '/'), re.I), 'msvc_redist_root')
    require(normalized(inventory['directory']) == normalized(ntpath.join(ntpath.dirname(target_root), 'native-windows-qa', 'materialized-dlls')), 'materialized_directory')
    files = inventory['files']
    require(0 < len(files) <= 256, 'dll_inventory_count')
    by_name = {}
    for item in files:
        name = item['name']
        require(re.fullmatch(r'[a-z0-9_.-]+\.dll', name, re.I) and name.lower() not in by_name, 'dll_inventory_name')
        require(type(item['wasSymbolicLink']) is bool, 'dll_link_attestation_type')
        origin = item['origin']
        require(origin in ('cargo-output', 'msvc-redist'), 'dll_origin')
        root = target if origin == 'cargo-output' else inventory['msvcRedistRoot']
        require(normalized(item['sourcePath']) == normalized(ntpath.join(root, name)), 'dll_source_path')
        require(within(target_root if origin == 'cargo-output' else root, item['resolvedPath']), 'dll_resolved_root')
        if origin == 'cargo-output' and item['wasSymbolicLink']:
            require(within(inventory['ortCache'], item['resolvedPath']) or within(target, item['resolvedPath']), 'dll_link_root')
        actual = dlls.get(name)
        require(actual and actual['bytes'] == item['bytes'] and actual['sha256'] == item['sha256'], 'dll_payload_inventory_identity')
        by_name[name.lower()] = item
    require({n.lower() for n in dlls} == set(by_name), 'dll_payload_exact_closure')
    require('directml.dll' in by_name and by_name['directml.dll']['origin'] == 'cargo-output', 'directml_build_provenance')
    require(any(i['origin'] == 'msvc-redist' for i in files), 'msvc_runtime_packaged')
    report = build / 'dll-dependencies.txt'
    require(report.stat().st_size <= 1024 * 1024, 'dll_report_budget')
    modules = []
    for line in report.read_text(encoding='utf-8-sig').splitlines():
        heading = re.fullmatch(r'Dump of file (.+)', line.strip())
        if heading:
            path = heading[1].strip('"')
            name = ntpath.basename(path).lower()
            require(name == 'jarvis.exe' or re.fullmatch(r'[a-z0-9_.-]+\.dll', name), 'inspected_module_name')
            require(not any(m['name'] == name for m in modules), 'duplicate_module_report')
            modules.append({'name': name, 'file': path, 'imports': []})
        else:
            imported = re.fullmatch(r'\s+([a-z0-9_.-]+\.dll)\s*', line, re.I)
            if imported:
                require(modules, 'import_without_module')
                name = imported[1].lower()
                if name not in modules[-1]['imports']:
                    modules[-1]['imports'].append(name)
    require({m['name'] for m in modules} == set(by_name) | {'jarvis.exe'}, 'all_packaged_modules_inspected')
    require(next(m for m in modules if m['name'] == 'jarvis.exe')['imports'], 'exe_import_report_empty')
    edges = []
    for module in modules:
        name = module['name']
        expected = ntpath.join(target, 'jarvis.exe') if name == 'jarvis.exe' else ntpath.join(inventory['directory'], by_name[name]['name'])
        require(normalized(expected) == normalized(module['file']), 'module_inspection_path')
        payload = build / 'binary' / ('jarvis.exe' if name == 'jarvis.exe' else by_name[name]['name'])
        actual_imports = pe_imports(payload, require)
        require(actual_imports == sorted(module['imports']), 'actual_pe_vs_dumpbin_imports')
        module['actualPEImports'] = actual_imports
        for imported in module['imports']:
            kind = 'packaged' if imported in by_name else 'windows-system-contract' if imported in SYSTEM or re.match(r'^(api|ext)-ms-win-', imported) else None
            require(kind, 'unresolved_non_system_import')
            edges.append({'module': name, 'imported': imported, 'kind': kind})
    declared = {'dependencies': edges, 'inventorySHA256': inventory_sha, 'runtimeAcceptance': 'Unrun'}
    require(provenance['dllClosure'] == declared and manifest['dllClosure'] == declared, 'declared_dll_graph_mismatch')
    return {'inventorySHA256': inventory_sha, 'inventory': inventory, 'modules': modules, 'dependencies': edges,
            'nonSystemClosure': 'PASS', 'actualPEImportsVsDumpbin': 'PASS',
            'systemRuntimeResolution': 'UNRUN', 'originAttestationLimit': 'Runner source paths and link types are hash-bound CI attestations; original runner filesystem is unavailable locally.'}
