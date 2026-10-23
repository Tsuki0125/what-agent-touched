#!/usr/bin/env python3
"""Build a .vsix without vsce or npm (a VSIX is a zip with a manifest)."""
import json
import os
import zipfile
from xml.sax.saxutils import escape

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES = [
    "package.json",
    "extension.js",
    "store.js",
    "README.md",
    "LICENSE",
    "hooks/claude_code.py",
    "hooks/install_claude_code_hook.py",
]


def main():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        pkg = json.load(f)
    manifest = """<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{display}</DisplayName>
    <Description xml:space="preserve">{desc}</Description>
    <Tags>{tags}</Tags>
    <Categories>{cats}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{engine}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="{kind}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="{repo}" />
    </Properties>
    <License>extension/LICENSE</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>
""".format(
        name=pkg["name"], version=pkg["version"], publisher=pkg["publisher"],
        display=escape(pkg["displayName"]), desc=escape(pkg["description"]),
        tags=escape(",".join(pkg.get("keywords", []))), cats=escape(",".join(pkg.get("categories", []))),
        engine=escape(pkg["engines"]["vscode"]), kind=",".join(pkg.get("extensionKind", ["workspace"])),
        repo=escape(pkg.get("repository", {}).get("url", "")))
    content_types = """<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".py" ContentType="text/plain" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>
"""
    out = os.path.join(ROOT, "%s-%s.vsix" % (pkg["name"], pkg["version"]))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("extension.vsixmanifest", manifest)
        for rel in FILES:
            z.write(os.path.join(ROOT, *rel.split("/")), "extension/" + rel)
    print(out)


if __name__ == "__main__":
    main()
