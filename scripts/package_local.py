"""Bundle a self-contained offline page and a source ZIP.

The ZIP leaves out data/raw (about 1.1 GB of BLS files); README.md explains how to download them.
"""

import base64
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def inline(html, pattern, replacement):
    """Replace exactly one tag matching pattern; fail loudly if the HTML changed shape."""
    html, count = re.subn(pattern, lambda _: replacement, html)
    assert count == 1, f"expected one match for {pattern!r}, found {count}"
    return html


# The standalone page can't fetch files, so it carries the diaries inline (base64).
PREFIX = "window.AMERICAN_MINUTE_DATA="
data_js = (DIST / "data.js").read_text()
assert data_js.startswith(PREFIX) and data_js.endswith(";\n")
data = json.loads(data_js[len(PREFIX) : -2])
data["diaryData"] = base64.b64encode((DIST / data.pop("diaryFile")).read_bytes()).decode("ascii")
data_js = PREFIX + json.dumps(data, separators=(",", ":")) + ";\n"

html = (DIST / "index.html").read_text()
html = inline(
    html,
    r'<link rel="stylesheet" href="styles\.css"\s*/?>',
    "<style>" + (DIST / "styles.css").read_text() + "</style>",
)
html = inline(html, r'<link rel="icon" href="icon\.svg"[^>]*>\s*', "")
html = inline(html, r'<link rel="apple-touch-icon" href="apple-touch-icon\.png"[^>]*>\s*', "")
html = inline(html, r'<script src="data\.js" defer></script>\s*', "")
html = inline(html, r'<script src="engine\.js" defer></script>\s*', "")
html = inline(html, r'<script src="app\.js" defer></script>\s*', "")
scripts = [data_js, (DIST / "engine.js").read_text(), (DIST / "app.js").read_text()]
html = inline(html, r"</body>", "".join(f"<script>{js}</script>" for js in scripts) + "</body>")
assert not re.search(r'src="(data|engine|app)\.js"|href="styles\.css"', html)
(ROOT.parent / "american-minute.html").write_text(html)

with zipfile.ZipFile(
    ROOT.parent / "american-minute-source.zip", "w", zipfile.ZIP_DEFLATED
) as archive:
    for p in ROOT.rglob("*"):
        parts = p.relative_to(ROOT).parts
        if p.is_file() and not any(
            part in {".git", "qa", "__pycache__", ".openai", "raw"} for part in parts
        ):
            archive.write(p, Path("american-minute") / p.relative_to(ROOT))
print("Packaged standalone website and source ZIP.")
