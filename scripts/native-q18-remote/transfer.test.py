import copy
import importlib.util
from pathlib import Path
import unittest

module_path = Path(__file__).with_name('transfer.py')
spec = importlib.util.spec_from_file_location('transfer', module_path)
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)

class FixedMetadataTests(unittest.TestCase):
    def metadata(self):
        aid, size, sha = transfer.ARTIFACTS['build']
        return {'id': aid, 'expired': False, 'size_in_bytes': size, 'digest': 'sha256:' + sha,
                'workflow_run': {'id': int(transfer.RUN), 'head_sha': transfer.SOURCE},
                'archive_download_url': f'https://api.github.com/repos/{transfer.REPO}/actions/artifacts/{aid}/zip'}
    def test_exact_metadata(self):
        self.assertTrue(transfer.verify_metadata('build', self.metadata()))
    def test_expired_or_wrong_id(self):
        for field,value in (('expired',True),('id',0)):
            m=self.metadata(); m[field]=value
            with self.assertRaises(ValueError): transfer.verify_metadata('build',m)
    def test_changed_size_digest(self):
        for field,value in (('size_in_bytes',1),('digest','sha256:'+'0'*64)):
            m=self.metadata(); m[field]=value
            with self.assertRaises(ValueError): transfer.verify_metadata('build',m)
    def test_source_run_drift(self):
        for field,value in (('id',0),('head_sha','0'*40)):
            m=self.metadata(); m['workflow_run'][field]=value
            with self.assertRaises(ValueError): transfer.verify_metadata('build',m)
    def test_redirect_endpoint_cannot_be_substituted(self):
        m=self.metadata(); m['archive_download_url']='https://foreign.invalid/archive.zip'
        with self.assertRaises(ValueError): transfer.verify_metadata('build',m)
    def test_unsafe_archive_paths(self):
        for name in ('../peer','/absolute','a/../peer','a\\peer','a/CON.txt','a/trailing.','a:stream'):
            with self.assertRaises(ValueError): transfer.safe_name(name)
    def test_valid_resource_path(self):
        self.assertEqual(str(transfer.safe_name('binary/resources/siyuan-runtime/guide/file.sy')), 'binary/resources/siyuan-runtime/guide/file.sy')
    def test_import_does_not_start_network_or_staging(self):
        self.assertIsNone(transfer.ROOT)

if __name__ == '__main__':
    unittest.main(verbosity=2)
