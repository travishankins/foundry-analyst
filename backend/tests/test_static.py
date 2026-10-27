def test_serves_the_spa_with_fallback_and_cache_rules(client, monkeypatch, tmp_path):
    from app import main

    site = tmp_path / "site"
    (site / "assets").mkdir(parents=True)
    (site / "index.html").write_text("<html>app</html>")
    (site / "assets" / "app-abc.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("top secret")
    monkeypatch.setattr(main, "find_static_dir", lambda: site.resolve())

    home = client.get("/")
    assert home.status_code == 200 and "app" in home.text and home.headers["cache-control"] == "no-cache"
    deep = client.get("/library/anything")
    assert deep.status_code == 200 and "<html>app</html>" in deep.text  # client-side routes fall back to index.html
    asset = client.get("/assets/app-abc.js")
    assert asset.text == "console.log(1)" and "immutable" in asset.headers["cache-control"]
    assert client.get("/..%2fsecret.txt").text == "<html>app</html>"
    assert "top secret" not in client.get("/%2e%2e/secret.txt").text


def test_unknown_api_paths_are_404_not_the_spa(client, monkeypatch, tmp_path):
    from app import main

    (tmp_path / "index.html").write_text("<html>app</html>")
    monkeypatch.setattr(main, "find_static_dir", lambda: tmp_path)
    assert client.get("/api/nope").status_code == 404
    assert "html" not in client.get("/api/nope").text.lower()


def test_no_static_build_means_404(client, monkeypatch):
    from app import main

    monkeypatch.setattr(main, "find_static_dir", lambda: None)
    assert client.get("/").status_code == 404


def test_security_headers_are_added_even_to_streams(client):
    thread = client.post("/api/threads").json()["thread_id"]
    resp = client.post(f"/api/threads/{thread}/messages", json={"content": "hi"})
    assert resp.headers["x-content-type-options"] == "nosniff" and resp.headers["x-frame-options"] == "DENY"
    assert client.get("/api/health").headers["referrer-policy"] == "same-origin"
