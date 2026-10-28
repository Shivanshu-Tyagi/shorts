const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeVideoUrl: n } = require("../src/utils/videoUrl");

describe("canonical identity", () => {
  test("same YouTube video, every URL shape + tracking params -> same key", () => {
    const keys = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share&t=10", "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
    ].map((u) => n(u).key);
    assert.deepEqual([...new Set(keys)], ["youtube:dQw4w9WgXcQ"]);
  });
  test("REGRESSION: old extractSourceId('watch?v=A') === extractSourceId('watch?v=B') === 'watch'; new ids differ", () => {
    const { extractSourceId } = require("../src/utils/sourceExtractor");
    const A = "https://www.youtube.com/watch?v=aaaaaaaaaaa", B = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
    assert.equal(extractSourceId(A), extractSourceId(B), "documents the old bug");
    assert.notEqual(n(A).key, n(B).key);
  });
  test("host variants (www/m/bare) and tracking params do not change identity", () => {
    assert.equal(n("https://instagram.com/reel/C1abcDEFghi/?igsh=1").key, n("https://www.instagram.com/p/C1abcDEFghi/").key);
  });
  test("identity-bearing params are kept (different v= => different video)", () => {
    assert.notEqual(n("https://www.facebook.com/watch/?v=111111111").key, n("https://www.facebook.com/watch/?v=222222222").key);
  });
  test("unknown path shapes fall back to a hash of the FULL url -> never merged by accident", () => {
    const a = n("https://www.facebook.com/someuser/posts/pfbid0aaa"), b = n("https://www.facebook.com/someuser/posts/pfbid0bbb");
    assert.match(a.videoId, /^h:/); assert.notEqual(a.key, b.key);
  });
  test("short links live in their own namespace", () => {
    assert.equal(n("https://vm.tiktok.com/ZMabc123/").key, "tiktok:s:ZMabc123");
    assert.equal(n("https://fb.watch/abCdE12/").key, "facebook:s:abCdE12");
  });
  test("per-platform ids", () => {
    assert.equal(n("https://www.tiktok.com/@u/video/7123456789012345678").videoId, "7123456789012345678");
    assert.equal(n("https://twitter.com/u/status/1700000000000000000?s=20").key, n("https://x.com/i/status/1700000000000000000").key);
    assert.equal(n("https://www.reddit.com/r/videos/comments/1ABC23/slug/").videoId, "1abc23");
    assert.equal(n("https://www.pinterest.com/pin/some-title-123456789012/").videoId, "123456789012");
    assert.equal(n("https://www.linkedin.com/posts/u_title-activity-7123456789012345678-AbCd").videoId, "7123456789012345678");
  });
  test("legacy compatibility flags", () => {
    assert.equal(n("https://www.instagram.com/reel/C1abcDEFghi/").legacySafe, true);
    assert.equal(n("https://www.youtube.com/watch?v=dQw4w9WgXcQ").legacySafe, false);
    assert.equal(n("https://www.reddit.com/r/videos/comments/1abc23/slug/").legacySafe, false);
    assert.deepEqual(n("https://www.instagram.com/p/C1abcDEFghi/").legacyHosts.sort(), ["instagram.com", "www.instagram.com"]);
  });
  test("provider URL is the cleaned original (no tracking, https, no hash)", () => {
    assert.equal(n("http://www.instagram.com/reel/C1abcDEFghi/?igsh=zz&utm_source=a#frag").providerUrl, "https://www.instagram.com/reel/C1abcDEFghi/");
  });
});

describe("validation / allow-list", () => {
  const bad = [
    [undefined, "INVALID_URL"], [123, "INVALID_URL"], ["", "INVALID_URL"], ["   ", "INVALID_URL"],
    ["https://www.instagram.com/p/abc de/", "INVALID_URL"], ["javascript:alert(1)", "INVALID_URL"], ["file:///etc/passwd", "INVALID_URL"],
    ["https://user:pw@www.instagram.com/p/abcde/", "INVALID_URL"], ["https://www.instagram.com:8443/p/abcde/", "INVALID_URL"],
    ["https://" + "a".repeat(3000) + ".com", "INVALID_URL"],
    ["http://127.0.0.1/x", "UNSUPPORTED_PLATFORM"], ["http://[::1]/x", "UNSUPPORTED_PLATFORM"], ["http://localhost/x", "UNSUPPORTED_PLATFORM"],
    ["http://169.254.169.254/latest/meta-data", "UNSUPPORTED_PLATFORM"], ["http://2130706433/", "UNSUPPORTED_PLATFORM"],
    ["https://example.com/video", "UNSUPPORTED_PLATFORM"], ["https://instagram.com.evil.com/p/abcde/", "UNSUPPORTED_PLATFORM"],
    ["https://evilinstagram.com/p/abcde/", "UNSUPPORTED_PLATFORM"],
  ];
  for (const [u, code] of bad) test(`rejects ${String(u).slice(0, 50)}`, () => assert.throws(() => n(u), { code, status: 400 }));
  test("extra allowed hosts are opt-in", () => {
    assert.throws(() => n("https://vimeo.com/123456"), { code: "UNSUPPORTED_PLATFORM" });
    assert.equal(n("https://vimeo.com/123456", { extraHosts: ["vimeo.com"] }).platform, "ext_vimeo.com");
  });
  test("schemeless input is accepted (users paste these)", () => assert.equal(n("instagram.com/p/C1abcDEFghi/").platform, "instagram"));
});
