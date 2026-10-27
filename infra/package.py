"""Builds the App Service deployment zip: backend code + runtime requirements + the built web app under static/.

Usage: python infra/package.py <output.zip>   (run `npm run build` first)
"""

import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
DIST = ROOT / "dist"
DEV_ONLY = ("pytest",)  # test tooling is not installed on the server


def add_tree(zf: zipfile.ZipFile, source: Path, prefix: str) -> int:
    count = 0
    for path in sorted(source.rglob("*")):
        if path.is_dir() or "__pycache__" in path.parts or path.suffix in {".pyc", ".pyo"}:
            continue
        zf.write(path, f"{prefix}/{path.relative_to(source).as_posix()}")
        count += 1
    return count


def main(output: Path) -> None:
    if not (DIST / "index.html").is_file():
        sys.exit("dist/index.html not found. Run `npm run build` first.")
    requirements = [
        line for line in (BACKEND / "requirements.txt").read_text(encoding="utf-8").splitlines()
        if not line.strip().lower().startswith(DEV_ONLY)
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("requirements.txt", "\n".join(requirements) + "\n")
        files = add_tree(zf, BACKEND / "app", "app") + add_tree(zf, BACKEND / "agents", "agents")
        files += add_tree(zf, DIST, "static")
    print(f"{output} ({output.stat().st_size / 1024:.0f} KB, {files + 1} files)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(Path(sys.argv[1]))
