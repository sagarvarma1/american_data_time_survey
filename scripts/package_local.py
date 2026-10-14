"""Bundle a self-contained offline page and a source ZIP.

The ZIP leaves out data/raw (about 1.1 GB of BLS files); README.md explains how to download them.
"""

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


html = (DIST / "index.html").read_text()
html = inline(
    html,
    r'<link rel="stylesheet" href="styles\.css"\s*/?>',
    "<style>" + (DIST / "styles.css").read_text() + "</style>",
)
html = inline(html, r'<link rel="icon" href="icon\.svg"[^>]*>\s*', "")
html = inline(html, r'<script src="data\.js" defer></script>\s*', "")
html = inline(html, r'<script src="app\.js" defer></script>\s*', "")
html = inline(
    html,
    r"</body>",
    "<script>"
    + (DIST / "data.js").read_text()
    + "</script><script>"
    + (DIST / "app.js").read_text()
    + "</script></body>",
)
assert (
    'src="app.js"' not in html and 'src="data.js"' not in html and 'href="styles.css"' not in html
)
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
