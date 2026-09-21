"""Plugin 3 large-file companion: bounded streaming, explicit hashes, journaled recovery.
No deletes except explicit rollback of files created by this helper. Not a sandbox
or a cross-file atomic transaction; other editors must use separate worktrees.
"""
from __future__ import annotations
import codecs, contextlib, hashlib, json, os, re, shutil, subprocess, sys, tempfile, uuid
from pathlib import Path, PureWindowsPath

BASE = Path(__file__).resolve().parent
CHUNK = 1024 * 1024
MAX_FILE = 1024 * 1024 * 1024
MAX_BATCH = 4 * MAX_FILE
MAX_FILES = 500
HASH = re.compile(r'^[a-fA-F0-9]{64}$')


def absolute(value):
    if not isinstance(value, (str, Path)) or not str(value):
        raise ValueError('An absolute path is required')
    p = Path(value)
    if not p.is_absolute():
        raise ValueError('An absolute path is required')
    return p


def no_links(p):
    p = absolute(p)
    for part in [p, *p.parents]:
        if part.is_symlink() or (hasattr(part, 'is_junction') and part.is_junction()):
            raise ValueError('Symbolic links and junctions are not supported: ' + str(part))
    if p.exists() and p.is_file() and p.stat().st_nlink != 1:
        raise ValueError('Hard-linked files are not supported: ' + str(p))
    return p


def root_path(value):
    p = no_links(absolute(value))
    if not p.is_dir():
        raise ValueError('Workspace root must be an existing directory')
    return p.resolve()


def target_path(root, relative):
    if not isinstance(relative, str) or not relative or '\x00' in relative:
        raise ValueError('A workspace-relative target is required')
    if Path(relative).is_absolute() or PureWindowsPath(relative).is_absolute() or ':' in relative:
        raise ValueError('Absolute paths and alternate data streams are forbidden')
    parts = relative.replace('\\', '/').split('/')
    if any(x in ('', '.', '..') or x.lower() == '.git' or x.rstrip(' .') != x for x in parts):
        raise ValueError('Traversal, ambiguous names, and .git edits are forbidden')
    reserved = {'con','prn','aux','nul',*(f'com{i}' for i in range(1,10)),*(f'lpt{i}' for i in range(1,10))}
    if any(x.split('.')[0].lower() in reserved or any(c in x for c in '<>"|?*') for x in parts):
        raise ValueError('Reserved Windows filename')
    p = no_links(root.joinpath(*parts))
    if not p.parent.is_dir():
        raise ValueError('Target parent must already exist; create directories explicitly: ' + str(p.parent))
    if p.exists() and not p.is_file():
        raise ValueError('Target is not a regular file')
    return p


def hash_file(file):
    h = hashlib.sha256()
    with absolute(file).open('rb') as stream:
        for data in iter(lambda: stream.read(CHUNK), b''):
            h.update(data)
    return h.hexdigest()


def current_hash(p):
    no_links(p)
    return hash_file(p) if p.exists() else None


def valid_hash(value, allow_none=False):
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not HASH.fullmatch(value):
        raise ValueError('A full SHA-256 is required (null only for a new target)')
    return value.lower()


def check_hash(p, expected):
    if current_hash(p) != expected:
        raise ValueError('Changed or unexpected file; inspect before retrying: ' + str(p))


def copy_checked(source, target, expected):
    """Exclusive destination; at most one MiB per read; flush before publish."""
    no_links(source)
    if source.stat().st_size > MAX_FILE:
        raise ValueError('File exceeds one GiB helper limit')
    h = hashlib.sha256()
    count = 0
    created = False
    try:
        with source.open('rb') as src, target.open('xb') as dest:
            created = True
            for data in iter(lambda: src.read(CHUNK), b''):
                count += len(data)
                if count > MAX_FILE:
                    raise ValueError('Source grew beyond the one GiB limit')
                h.update(data)
                dest.write(data)
            dest.flush()
            os.fsync(dest.fileno())
        if h.hexdigest() != expected:
            raise ValueError('Source changed while staging: ' + str(source))
        shutil.copymode(source, target)
        return count
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise


def save_json(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name('.' + file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8', newline='\n') as out:
            json.dump(data, out, indent=2)
            out.write('\n')
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


@contextlib.contextmanager
def workspace_lock(root, state):
    root = root_path(root)
    lockdir = Path(state) / 'locks'
    lockdir.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(os.path.normcase(str(root)).encode()).hexdigest()
    lock = lockdir / (key + '.lock')
    try:
        handle = lock.open('x', encoding='utf-8')
    except FileExistsError:
        raise ValueError('Workspace locked. Never remove a lock until its writer is stopped and its journal is inspected: ' + str(lock)) from None
    try:
        handle.write(json.dumps({'pid':os.getpid(),'root':str(root)}))
        handle.flush()
        os.fsync(handle.fileno())
        yield
    finally:
        handle.close()
        lock.unlink(missing_ok=True)


def prepare(request):
    if not isinstance(request, dict):
        raise ValueError('Request must be an object')
    root = root_path(request.get('root'))
    changes = request.get('changes')
    if not isinstance(changes, list) or not 1 <= len(changes) <= MAX_FILES:
        raise ValueError('Provide between 1 and 500 changes')
    items, seen, total = [], set(), 0
    for change in changes:
        if not isinstance(change, dict) or 'expectedSha256' not in change:
            raise ValueError('Every target requires explicit expectedSha256')
        target = target_path(root, change.get('path'))
        # Conservatively reject case aliases even on case-sensitive hosts.
        identity = str(target).casefold()
        if identity in seen:
            raise ValueError('Duplicate target')
        seen.add(identity)
        source = no_links(absolute(change.get('source')))
        if not source.is_file():
            raise ValueError('Source must be a regular file')
        old = valid_hash(change['expectedSha256'], True)
        new = valid_hash(change.get('sourceSha256'))
        check_hash(target, old)
        check_hash(source, new)
        sizes = source.stat().st_size + (target.stat().st_size if target.exists() else 0)
        if source.stat().st_size > MAX_FILE or (target.exists() and target.stat().st_size > MAX_FILE):
            raise ValueError('File exceeds one GiB helper limit')
        total += sizes
        if total > MAX_BATCH:
            raise ValueError('Batch exceeds four GiB combined source/backup limit')
        items.append({'relative':str(target.relative_to(root)), 'target':str(target), 'source':str(source), 'old':old, 'new':new, 'bytes':source.stat().st_size})
    return root, items, total


def plan(request):
    root, items, total = prepare(request)
    return {'status':'checked_not_applied','root':str(root),'files':len(items),'stagingAndBackupBytes':total,'changes':[{'path':i['relative'],'action':'create' if i['old'] is None else 'replace','bytes':i['bytes']} for i in items]}


def apply(request, state=BASE/'state'):
    root = root_path(request.get('root'))
    state = no_links(absolute(state))
    with workspace_lock(root, state):
        root, items, total = prepare(request)
        txid = uuid.uuid4().hex
        tx = state/'transactions'/txid
        tx.mkdir(parents=True, exist_ok=False)
        receipt = tx/'receipt.json'
        journal = {'version':1,'id':txid,'root':str(root),'status':'preparing','files':items,'pid':os.getpid()}
        for index, item in enumerate(items):
            item.update(backup=str(tx/f'{index}.before'),stage=str(Path(item['target']).with_name('.p3-'+txid+f'-{index}.stage')),phase='planned')
        save_json(receipt, journal)
        try:
            # Complete every backup and stage before the first target mutation.
            for item in items:
                target, source, stage = map(Path, (item['target'],item['source'],item['stage']))
                if item['old'] is not None:
                    copy_checked(target, Path(item['backup']), item['old'])
                copy_checked(source, stage, item['new'])
                if target.exists():
                    shutil.copymode(target, stage)
                item['phase']='staged'
                save_json(receipt, journal)
            for item in items:
                check_hash(target_path(root,item['relative']),item['old'])
            journal['status']='committing'
            save_json(receipt, journal)
            for item in items:
                target = target_path(root,item['relative'])
                check_hash(target,item['old'])
                item['phase']='commit_intent'
                save_json(receipt,journal)
                if item['old'] is None:
                    # Exclusive publication refuses a file created after preflight.
                    if os.name == 'nt':
                        os.rename(item['stage'],target)  # Windows refuses existing destinations.
                    else:
                        os.link(item['stage'],target)
                        Path(item['stage']).unlink()
                else:
                    os.replace(item['stage'],target)
                check_hash(target,item['new'])
                item['phase']='committed'
                save_json(receipt,journal)
            journal['status']='applied'
            save_json(receipt,journal)
            return {'status':'applied','files':len(items),'bytes':sum(i['bytes'] for i in items),'receipt':str(receipt),'atomicAcrossFiles':False}
        except BaseException as error:
            journal['status']='interrupted'
            journal['error']=str(error)[:300]
            save_json(receipt,journal)
            raise ValueError('Batch interrupted; inspect before retry. Explicit rollback receipt: '+str(receipt)+'; '+str(error)) from error


def rollback(receipt_path, state=BASE/'state'):
    state = no_links(absolute(state)).resolve()
    receipt = no_links(absolute(receipt_path)).resolve()
    if receipt.name != 'receipt.json' or receipt.parent.parent != state/'transactions' or not re.fullmatch(r'[a-f0-9]{32}',receipt.parent.name):
        raise ValueError('Receipt must be from this helper transaction directory')
    journal = json.loads(receipt.read_text(encoding='utf-8'))
    if journal.get('version') != 1 or journal.get('id') != receipt.parent.name:
        raise ValueError('Invalid transaction receipt')
    root = root_path(journal.get('root'))
    with workspace_lock(root,state):
        items=journal.get('files',[])
        if not 1 <= len(items) <= MAX_FILES:
            raise ValueError('Invalid receipt entries')
        actions=[]
        for index,item in enumerate(items):
            target=target_path(root,item['relative'])
            if str(target)!=item['target']:
                raise ValueError('Receipt target mismatch')
            old,new=valid_hash(item['old'],True),valid_hash(item['new'])
            actual=current_hash(target)
            if actual==old:
                actions.append(False)
                continue
            if actual!=new:
                raise ValueError('Rollback conflict: newer edits will not be overwritten: '+str(target))
            backup=receipt.parent/f'{index}.before'
            if str(backup)!=item['backup']:
                raise ValueError('Receipt backup mismatch')
            if old is not None:
                check_hash(backup,old)
            actions.append(True)
        journal['status']='rolling_back'
        save_json(receipt,journal)
        for index,(item,needed) in enumerate(zip(items,actions)):
            target=target_path(root,item['relative'])
            if needed:
                check_hash(target,item['new'])
                if item['old'] is None:
                    target.unlink()
                else:
                    stage=target.with_name('.p3-rollback-'+uuid.uuid4().hex+'.stage')
                    try:
                        copy_checked(Path(item['backup']),stage,item['old'])
                        check_hash(target,item['new'])
                        os.replace(stage,target)
                    finally:
                        stage.unlink(missing_ok=True)
                    check_hash(target,item['old'])
            item['phase']='rolled_back'
            save_json(receipt,journal)
            expected_stage=target.with_name('.p3-'+journal['id']+f'-{index}.stage')
            if item.get('stage')==str(expected_stage):
                expected_stage.unlink(missing_ok=True)
        journal['status']='rolled_back'
        save_json(receipt,journal)
        return {'status':'rolled_back','files':len(items),'receipt':str(receipt)}


def replace_stream(request):
    source=no_links(absolute(request.get('source')))
    output=no_links(absolute(request.get('output')))
    if output.exists() or not output.parent.is_dir():
        raise ValueError('Output must be a new file in an existing directory')
    expected=valid_hash(request.get('expectedSha256'))
    old=request.get('old'); new=request.get('new'); wanted=request.get('expectedReplacements')
    if not isinstance(old,str) or not old or not isinstance(new,str) or not isinstance(wanted,int) or isinstance(wanted,bool) or wanted<1:
        raise ValueError('Non-empty old text, new text, and positive exact replacement count are required')
    needle,replacement=old.encode('utf-8'),new.encode('utf-8')
    if len(needle)>CHUNK or len(replacement)>CHUNK or source.stat().st_size>MAX_FILE:
        raise ValueError('Replacement strings limited to one MiB; file limited to one GiB')
    stage=output.with_name('.p3-derived-'+uuid.uuid4().hex+'.stage')
    count=0; pending=b''; digest=hashlib.sha256(); written=0; read=0
    decoder=codecs.getincrementaldecoder('utf-8')('strict')
    try:
        with source.open('rb') as src,stage.open('xb') as dst:
            def emit(data):
                nonlocal written
                written+=len(data)
                if written>MAX_FILE:
                    raise ValueError('Replacement output exceeds one GiB')
                dst.write(data)
            for data in iter(lambda:src.read(CHUNK),b''):
                read+=len(data)
                if read>MAX_FILE: raise ValueError('Source grew beyond one GiB')
                digest.update(data); decoder.decode(data); pending+=data
                safe=max(0,len(pending)-len(needle)+1); cursor=0
                while True:
                    index=pending.find(needle,cursor)
                    if index<0 or index>=safe: break
                    emit(pending[cursor:index]);emit(replacement);count+=1;cursor=index+len(needle)
                end=max(cursor,safe);emit(pending[cursor:end]);pending=pending[end:]
            decoder.decode(b'',final=True)
            count+=pending.count(needle);emit(pending.replace(needle,replacement))
            dst.flush();os.fsync(dst.fileno())
        if digest.hexdigest()!=expected: raise ValueError('Source hash mismatch')
        if count!=wanted: raise ValueError(f'Expected {wanted} replacements, found {count}')
        # Exclusive publish: unlike replace(), link() refuses an existing path.
        os.link(stage,output);stage.unlink()
        return {'status':'derived_only','output':str(output),'sha256':hash_file(output),'bytes':written,'replacements':count,'sourceUnchanged':True}
    finally:
        stage.unlink(missing_ok=True)


def git_run(root,args):
    root=root_path(root)
    result=subprocess.run(['git','--no-optional-locks','-C',str(root),*args],capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
    if result.returncode:
        raise ValueError(result.stderr[:4000] or 'Git command failed')
    return {'status':'ok','output':result.stdout[:131072],'truncated':len(result.stdout)>131072}


def main(argv):
    if not argv: raise ValueError('Usage: files hash PATH | plan/apply MANIFEST | rollback RECEIPT | replace REQUEST | git-status ROOT | git-check-patch ROOT PATCH | git-worktree ROOT DEST BRANCH')
    command=argv[0]
    if command=='hash' and len(argv)==2:
        return {'path':str(absolute(argv[1])),'sha256':hash_file(absolute(argv[1]))}
    if command in ('plan','apply','replace') and len(argv)==2:
        file=absolute(argv[1])
        if file.stat().st_size>4*CHUNK: raise ValueError('Request exceeds four MiB')
        request=json.loads(file.read_text(encoding='utf-8-sig'))
        return {'plan':plan,'apply':apply,'replace':replace_stream}[command](request)
    if command=='rollback' and len(argv)==2: return rollback(argv[1])
    if command=='git-status' and len(argv)==2: return git_run(argv[1],['status','--short','--branch'])
    if command=='git-check-patch' and len(argv)==3: return git_run(argv[1],['apply','--check','--',str(absolute(argv[2]))])
    if command=='git-worktree' and len(argv)==4:
        root=root_path(argv[1]); dest=absolute(argv[2]); branch=argv[3]
        if dest.exists() or not dest.parent.is_dir() or not re.fullmatch(r'p3/[A-Za-z0-9][A-Za-z0-9._-]{0,63}',branch):
            raise ValueError('Use a new destination under an existing parent and a p3/task-name branch')
        with workspace_lock(root,BASE/'state'):
            return git_run(root,['worktree','add','-b',branch,str(dest),'HEAD'])
    raise ValueError('Unknown command or incorrect argument count')

if __name__=='__main__':
    try: print(json.dumps(main(sys.argv[1:]),ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'error','error':str(error)},ensure_ascii=False));sys.exit(1)
