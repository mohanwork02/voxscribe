import json
import tempfile
import time
import unittest
from pathlib import Path


class TestIndexMetadata(unittest.TestCase):
    def setUp(self) -> None:
        import smart_input_llm as s

        self.s = s
        self.tmpdir = Path(tempfile.mkdtemp(prefix="kb_meta_test_"))

        self._orig = {
            "OUTPUT_DIR": s.OUTPUT_DIR,
            "FAISS_INDEX_FILE": s.FAISS_INDEX_FILE,
            "FAISS_META_FILE": s.FAISS_META_FILE,
            "VECTORS_FILE": s.VECTORS_FILE,
            "VERIFICATION_FILE": s.VERIFICATION_FILE,
        }

        s.OUTPUT_DIR = self.tmpdir
        s.FAISS_INDEX_FILE = self.tmpdir / "faiss.index"
        s.FAISS_META_FILE = self.tmpdir / "faiss_meta.json"
        s.VECTORS_FILE = self.tmpdir / "vectors.npy"
        s.VERIFICATION_FILE = self.tmpdir / "verification.txt"

    def tearDown(self) -> None:
        s = self.s
        for k, v in self._orig.items():
            setattr(s, k, v)

        # Best-effort cleanup
        try:
            for child in self.tmpdir.glob("*"):
                child.unlink(missing_ok=True)
            self.tmpdir.rmdir()
        except Exception:
            pass

    def test_index_matches_files_with_signature(self) -> None:
        s = self.s
        f1 = self.tmpdir / "a.txt"
        f2 = self.tmpdir / "b.txt"
        f1.write_text("hello", encoding="utf-8")
        f2.write_text("world", encoding="utf-8")

        sources = s.compute_sources_metadata([f1, f2])
        meta = {"texts": ["x"], "sources": sources, "sources_sig": s._sources_signature(sources)}
        s.FAISS_META_FILE.parent.mkdir(parents=True, exist_ok=True)
        s.FAISS_META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")

        self.assertTrue(s.index_matches_files([str(f1), str(f2)]))

        # Change one file (mtime/size) -> signature mismatch
        time.sleep(1.1)
        f2.write_text("world!!!", encoding="utf-8")
        self.assertFalse(s.index_matches_files([str(f1), str(f2)]))

    def test_index_matches_files_requires_sources(self) -> None:
        s = self.s
        s.FAISS_META_FILE.parent.mkdir(parents=True, exist_ok=True)
        s.FAISS_META_FILE.write_text(json.dumps({"texts": ["x"]}), encoding="utf-8")
        self.assertFalse(s.index_matches_files(["whatever.pdf"]))

    def test_read_saved_domain_returns_normalized_value(self) -> None:
        s = self.s
        s.FAISS_META_FILE.parent.mkdir(parents=True, exist_ok=True)
        s.FAISS_META_FILE.write_text(
            json.dumps({"texts": ["x"], "domain": "  data   science  "}, indent=2),
            encoding="utf-8",
        )

        self.assertEqual(s.read_saved_domain(), "data science")

if __name__ == "__main__":
    unittest.main()

