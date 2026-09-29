using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Cs2VoiceMatcher.Core;
using Microsoft.AspNetCore.Http.Features;
using ZstdSharp;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors();
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
{
    o.MultipartBodyLengthLimit = 1_000_000_000; // 1GB
    o.ValueLengthLimit = 1_000_000_000;
});
builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 1_000_000_000); // 1GB

var app = builder.Build();
app.UseCors(p => p.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
app.UseStaticFiles();

// ── State ──────────────────────────────────────────
var dbPath = Environment.GetEnvironmentVariable("DB_PATH") ?? "data/voiceprints.db";
Directory.CreateDirectory(Path.GetDirectoryName(dbPath)!);
var uploadsDir = Path.Combine(app.Environment.ContentRootPath, "uploads");
Directory.CreateDirectory(uploadsDir);
var audioDir = Path.GetFullPath(Environment.GetEnvironmentVariable("AUDIO_PATH") ?? "data/audio");
Directory.CreateDirectory(audioDir);

// Serve audio files as static content
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(Path.GetFullPath(audioDir)),
    RequestPath = "/audio"
});

var db = new ProfileDatabase(dbPath);
var jobs = new ConcurrentDictionary<string, JobStatus>();
var processingLock = new SemaphoreSlim(1, 1);
var faceitToken = Environment.GetEnvironmentVariable("FACEIT_TOKEN") ?? "";

// ── Initialize neural speaker embedder ─────────────
var modelPath = Environment.GetEnvironmentVariable("SPEAKER_MODEL_PATH") ?? "models/speaker_model.onnx";
SpeakerEmbedder? speakerEmbedder = null;
if (File.Exists(modelPath))
{
    speakerEmbedder = new SpeakerEmbedder(modelPath);
    Console.WriteLine($"Speaker embedding model loaded from {modelPath}");
}
else
{
    Console.WriteLine($"WARNING: Speaker model not found at {modelPath}. Neural embeddings disabled.");
}

// ═══════════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════════

// ── Import from FACEIT URL ─────────────────────────
app.MapPost("/api/import-faceit", async (HttpRequest req) =>
{
    var body = await req.ReadFromJsonAsync<JsonElement>();
    var url = body.GetProperty("url").GetString() ?? "";

    // Extract match ID from FACEIT URL or use as-is
    var matchId = url.Trim();
    if (matchId.Contains("faceit.com"))
    {
        var parts = matchId.Split('/');
        matchId = parts.LastOrDefault(p => p.StartsWith("1-")) ?? parts.Last();
    }
    if (string.IsNullOrEmpty(matchId))
        return Results.BadRequest(new { error = "Invalid FACEIT URL" });

    if (string.IsNullOrEmpty(faceitToken))
        return Results.BadRequest(new { error = "FACEIT_TOKEN is not configured on the server" });

    using var http = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
    http.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
    http.DefaultRequestHeaders.Add("Authorization", $"Bearer {faceitToken}");
    http.DefaultRequestHeaders.Add("Accept", "application/json");

    // ── Step 1: Get match data from FACEIT API ──
    Console.WriteLine($"[FACEIT] Fetching match {matchId}...");

    JsonElement matchData;
    string? demoResourceUrl = null;

    // Try Open Data API v4 first (requires server-side API key)
    var v4Resp = await http.GetAsync($"https://open.faceit.com/data/v4/matches/{matchId}");
    Console.WriteLine($"[FACEIT] Open Data API v4: {v4Resp.StatusCode}");

    if (v4Resp.IsSuccessStatusCode)
    {
        matchData = await v4Resp.Content.ReadFromJsonAsync<JsonElement>();

        if (matchData.TryGetProperty("demo_url", out var demoUrls) &&
            demoUrls.ValueKind == JsonValueKind.Array && demoUrls.GetArrayLength() > 0)
            demoResourceUrl = demoUrls[0].GetString();
    }
    else
    {
        // Fallback: try internal APIs (work with some legacy tokens)
        Console.WriteLine("[FACEIT] V4 failed, trying internal API...");
        var v2Resp = await http.GetAsync($"https://api.faceit.com/match/v2/match/{matchId}");
        if (!v2Resp.IsSuccessStatusCode)
            v2Resp = await http.GetAsync($"https://www.faceit.com/api/match/v2/match/{matchId}");
        if (!v2Resp.IsSuccessStatusCode)
        {
            var errBody = await v2Resp.Content.ReadAsStringAsync();
            Console.WriteLine($"[FACEIT] All APIs failed: {v2Resp.StatusCode} {errBody[..Math.Min(300, errBody.Length)]}");
            return Results.BadRequest(new { error = $"FACEIT API error: {v2Resp.StatusCode}. Check FACEIT_TOKEN." });
        }
        var wrapper = await v2Resp.Content.ReadFromJsonAsync<JsonElement>();
        matchData = wrapper.GetProperty("payload");

        if (matchData.TryGetProperty("demo_url", out var demoUrlArr) &&
            demoUrlArr.ValueKind == JsonValueKind.Array && demoUrlArr.GetArrayLength() > 0)
            demoResourceUrl = demoUrlArr[0].GetString();
        else if (matchData.TryGetProperty("demoURLs", out var urls) && urls.GetArrayLength() > 0)
            demoResourceUrl = urls[0].GetString();
    }

    if (string.IsNullOrEmpty(demoResourceUrl))
        return Results.BadRequest(new { error = "No demo URL available for this match (demo may not be ready yet)" });

    Console.WriteLine($"[FACEIT] Demo resource URL: {demoResourceUrl}");

    // ── Extract match metadata (works for both v4 and v2 response formats) ──
    var teamNames = new List<string>();
    if (matchData.TryGetProperty("teams", out var teams))
        foreach (var prop in teams.EnumerateObject())
            if (prop.Value.TryGetProperty("name", out var tn))
                teamNames.Add(tn.GetString() ?? "");

    var mapName = "unknown";
    var serverLocation = "";
    if (matchData.TryGetProperty("voting", out var voting))
    {
        if (voting.TryGetProperty("map", out var mapObj) &&
            mapObj.TryGetProperty("pick", out var picks) && picks.GetArrayLength() > 0)
            mapName = picks[0].GetString() ?? "unknown";
        if (voting.TryGetProperty("location", out var locObj) &&
            locObj.TryGetProperty("pick", out var locPicks) && locPicks.GetArrayLength() > 0)
            serverLocation = locPicks[0].GetString() ?? "";
    }

    var region = matchData.TryGetProperty("region", out var reg) ? reg.GetString() : "";
    var title = teamNames.Count >= 2 ? $"{teamNames[0]} vs {teamNames[1]}" : matchId;

    int score1 = 0, score2 = 0;
    if (matchData.TryGetProperty("results", out var resultsEl))
    {
        JsonElement scoreObj = default;
        if (resultsEl.ValueKind == JsonValueKind.Array && resultsEl.GetArrayLength() > 0)
            resultsEl[0].TryGetProperty("score", out scoreObj);
        else if (resultsEl.ValueKind == JsonValueKind.Object)
            resultsEl.TryGetProperty("score", out scoreObj);
        if (scoreObj.ValueKind == JsonValueKind.Object)
        {
            if (scoreObj.TryGetProperty("faction1", out var s1)) score1 = s1.GetInt32();
            if (scoreObj.TryGetProperty("faction2", out var s2)) score2 = s2.GetInt32();
        }
    }

    // ── Step 2: Download demo file ──
    var destDem = Path.Combine(uploadsDir, $"{matchId}.dem");
    string? demoError = null;

    if (!File.Exists(destDem))
    {
        http.DefaultRequestHeaders.Remove("Accept");
        HttpResponseMessage? demoResp = null;
        string? signedDownloadUrl = null;

        // Strategy A: FACEIT Downloads API → signed URL
        // Requires FACEIT_TOKEN with "downloads" scope (apply: https://fce.gg/downloads-api-application)
        try
        {
            Console.WriteLine("[FACEIT] Requesting signed URL from Downloads API...");
            http.DefaultRequestHeaders.Add("Accept", "application/json");

            foreach (var baseUrl in new[] { "https://open.faceit.com", "https://api.faceit.com" })
            {
                var dlResp = await http.PostAsJsonAsync($"{baseUrl}/download/v2/demos/download",
                    new { resource_url = demoResourceUrl });
                Console.WriteLine($"[FACEIT] Downloads API ({baseUrl}): {dlResp.StatusCode}");

                if (dlResp.IsSuccessStatusCode)
                {
                    var dlJson = await dlResp.Content.ReadFromJsonAsync<JsonElement>();
                    if (dlJson.TryGetProperty("payload", out var pl) &&
                        pl.TryGetProperty("download_url", out var signedUrl))
                    {
                        signedDownloadUrl = signedUrl.GetString();
                        Console.WriteLine($"[FACEIT] Got signed download URL");
                        break;
                    }
                }
                else
                {
                    var errBody = await dlResp.Content.ReadAsStringAsync();
                    Console.WriteLine($"[FACEIT] Downloads API error: {errBody[..Math.Min(300, errBody.Length)]}");
                }
            }
            http.DefaultRequestHeaders.Remove("Accept");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[FACEIT] Downloads API exception: {ex.Message}");
            http.DefaultRequestHeaders.Remove("Accept");
        }

        // Strategy B: Direct download from all available URLs
        var urlsToTry = new List<string>();
        if (!string.IsNullOrEmpty(signedDownloadUrl))
            urlsToTry.Add(signedDownloadUrl);
        urlsToTry.Add(demoResourceUrl);

        // Try alternate CDN domain patterns
        try
        {
            var uri = new Uri(demoResourceUrl);
            if (demoResourceUrl.Contains("demos.faceit.com"))
            {
                urlsToTry.Add($"https://demos-europe-west.backblaze.faceit-cdn.net{uri.AbsolutePath}");
                urlsToTry.Add($"https://demos-us-east.backblaze.faceit-cdn.net{uri.AbsolutePath}");
            }
            else if (demoResourceUrl.Contains("faceit-cdn.net"))
            {
                urlsToTry.Add($"https://demos.faceit.com{uri.AbsolutePath}");
            }
        }
        catch { }
        urlsToTry = urlsToTry.Distinct().ToList();

        foreach (var tryUrl in urlsToTry)
        {
            try
            {
                Console.WriteLine($"[FACEIT] Trying download: {tryUrl[..Math.Min(100, tryUrl.Length)]}...");
                using var dlClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
                dlClient.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
                // Don't send Bearer token for signed/pre-signed URLs
                if (tryUrl != signedDownloadUrl)
                    dlClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {faceitToken}");

                demoResp = await dlClient.GetAsync(tryUrl, HttpCompletionOption.ResponseHeadersRead);
                if (demoResp.IsSuccessStatusCode)
                {
                    var ct = demoResp.Content.Headers.ContentType?.MediaType ?? "";
                    if (ct.Contains("html"))
                    {
                        Console.WriteLine($"[FACEIT] Got HTML response, skipping...");
                        demoResp = null;
                        continue;
                    }
                    Console.WriteLine($"[FACEIT] Download OK (size: {demoResp.Content.Headers.ContentLength?.ToString() ?? "unknown"})");
                    break;
                }
                Console.WriteLine($"[FACEIT] Failed ({demoResp.StatusCode})");
                demoResp = null;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[FACEIT] Download error: {ex.Message}");
                demoResp = null;
            }
        }

        // Save & decompress
        if (demoResp != null && demoResp.IsSuccessStatusCode)
        {
            var successUrl = demoResp.RequestMessage?.RequestUri?.ToString() ?? demoResourceUrl;
            var isZst = successUrl.Contains(".dem.zst") || demoResourceUrl.EndsWith(".zst");
            var isGz = successUrl.Contains(".dem.gz") || demoResourceUrl.EndsWith(".gz");

            if (isZst)
            {
                var destZst = Path.Combine(uploadsDir, $"{matchId}.dem.zst");
                await using (var fs = File.Create(destZst))
                    await demoResp.Content.CopyToAsync(fs);
                try
                {
                    await using var input = File.OpenRead(destZst);
                    await using var output = File.Create(destDem);
                    await using var ds = new DecompressionStream(input);
                    await ds.CopyToAsync(output);
                }
                catch (Exception ex)
                {
                    demoError = $"Zstd decompression failed: {ex.Message}";
                }
                try { File.Delete(destZst); } catch { }
            }
            else if (isGz)
            {
                var destGz = Path.Combine(uploadsDir, $"{matchId}.dem.gz");
                await using (var fs = File.Create(destGz))
                    await demoResp.Content.CopyToAsync(fs);
                try
                {
                    await using var gzStream = new System.IO.Compression.GZipStream(
                        File.OpenRead(destGz), System.IO.Compression.CompressionMode.Decompress);
                    await using var outFs = File.Create(destDem);
                    await gzStream.CopyToAsync(outFs);
                }
                catch (Exception ex) { demoError = $"GZip decompression failed: {ex.Message}"; }
                try { File.Delete(destGz); } catch { }
            }
            else
            {
                await using (var fs = File.Create(destDem))
                    await demoResp.Content.CopyToAsync(fs);
            }

            // Sanity check
            if (File.Exists(destDem) && demoError == null)
            {
                var fileSize = new FileInfo(destDem).Length;
                if (fileSize < 1024)
                {
                    demoError = "Downloaded file is too small — likely not a valid demo";
                    try { File.Delete(destDem); } catch { }
                }
                else
                    Console.WriteLine($"[FACEIT] Demo saved: {destDem} ({fileSize / 1024 / 1024}MB)");
            }
        }
        else
        {
            demoError = "Demo download failed. FACEIT_TOKEN needs Downloads API scope — apply at https://fce.gg/downloads-api-application";
        }
    }
    else
    {
        Console.WriteLine($"[FACEIT] Demo already exists: {destDem}");
    }

    return Results.Ok(new
    {
        matchId, title, mapName, region, serverLocation, score1, score2,
        demoFile = File.Exists(destDem) ? Path.GetFileName(destDem) : (string?)null,
        demoUrl = demoResourceUrl,
        demoError
    });
});

// ── Upload demos ───────────────────────────────────
app.MapPost("/api/upload", async (HttpRequest req) =>
{
    var form = await req.ReadFormAsync();
    var files = form.Files;
    if (files.Count == 0) return Results.BadRequest(new { error = "No files uploaded" });

    var saved = new List<string>();
    foreach (var f in files)
    {
        var fn = f.FileName;
        if (fn.EndsWith(".dem", StringComparison.OrdinalIgnoreCase))
        {
            var dest = Path.Combine(uploadsDir, $"{Guid.NewGuid()}_{fn}");
            await using var stream = File.Create(dest);
            await f.CopyToAsync(stream);
            saved.Add(dest);
        }
        else if (fn.EndsWith(".dem.zst", StringComparison.OrdinalIgnoreCase))
        {
            var zstPath = Path.Combine(uploadsDir, $"{Guid.NewGuid()}_{fn}");
            await using (var stream = File.Create(zstPath))
                await f.CopyToAsync(stream);

            var demPath = zstPath[..^4]; // strip .zst
            try
            {
                await using var input = File.OpenRead(zstPath);
                await using var output = File.Create(demPath);
                await using var ds = new DecompressionStream(input);
                await ds.CopyToAsync(output);
                saved.Add(demPath);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Zstd decompression failed for {fn}: {ex.Message}");
            }
            try { File.Delete(zstPath); } catch { }
        }
    }

    return Results.Ok(new { count = saved.Count, files = saved.Select(Path.GetFileName) });
});

// ── Process all uploaded demos ─────────────────────
app.MapPost("/api/process", () =>
{
    if (!processingLock.Wait(0))
        return Results.Conflict(new { error = "Processing already in progress" });

    var demFiles = Directory.GetFiles(uploadsDir, "*.dem");
    if (demFiles.Length == 0) { processingLock.Release(); return Results.BadRequest(new { error = "No demo files to process" }); }

    var jobId = Guid.NewGuid().ToString("N")[..8];
    var job = new JobStatus { Id = jobId, TotalDemos = demFiles.Length };
    jobs[jobId] = job;

    _ = Task.Run(async () =>
    {
        job.State = "processing";

        foreach (var demoPath in demFiles)
        {
            try
            {
                job.CurrentDemo = Path.GetFileName(demoPath);

                // Hash check (fast — read in chunks)
                string hash;
                using (var sha = SHA256.Create())
                await using (var fs = File.OpenRead(demoPath))
                    hash = Convert.ToHexString(await sha.ComputeHashAsync(fs)).ToLowerInvariant();

                if (db.DemoHashExists(hash))
                {
                    job.ProcessedDemos++;
                    continue;
                }

                // Extract voice data + save WAV files
                var demoAudioDir = Path.Combine(audioDir, hash);
                var voiceData = await AudioExtractor.ExtractVoiceDataAsync(demoPath, demoAudioDir);
                if (voiceData.Count == 0)
                {
                    job.ProcessedDemos++;
                    continue;
                }

                var first = voiceData.Values.First();
                var totalPlayers = voiceData.Count;
                var demoId = db.InsertDemo(demoPath, hash, first.MapName, first.HostName, totalPlayers);

                foreach (var (steamId, pv) in voiceData)
                {
                    VoiceProfile profile;
                    if (pv.PcmSegments.Count == 0 || pv.TotalDurationSeconds == 0)
                    {
                        // Silent player — store with zero embedding
                        profile = new VoiceProfile
                        {
                            SteamId = steamId, PlayerName = pv.PlayerName ?? "", DemoFile = demoPath,
                            MfccEmbedding = new float[SpeakerEmbedder.EmbeddingDim],
                            TotalFrames = 0,
                            SpeakingSeconds = 0
                        };
                    }
                    else if (speakerEmbedder != null)
                    {
                        var allPcm = pv.PcmSegments.SelectMany(s => s).ToArray();
                        profile = VoiceProfileBuilder.BuildProfile(speakerEmbedder, steamId, pv.PlayerName ?? "", demoPath, allPcm, pv.TotalDurationSeconds);
                    }
                    else
                    {
                        var allPcm = pv.PcmSegments.SelectMany(s => s).ToArray();
                        var mfcc = MfccExtractor.ComputeMfcc(allPcm);
                        profile = new VoiceProfile
                        {
                            SteamId = steamId, PlayerName = pv.PlayerName ?? "", DemoFile = demoPath,
                            MfccEmbedding = new float[SpeakerEmbedder.EmbeddingDim],
                            TotalFrames = mfcc.Length,
                            SpeakingSeconds = pv.TotalDurationSeconds
                        };
                    }
                    profile.DemoId = demoId;
                    profile.TeamNumber = pv.TeamNumber;
                    db.InsertProfile(profile);
                    job.PlayersFound++;
                }

                // Delete processed file + free memory
                try { File.Delete(demoPath); } catch { }
                GC.Collect(0, GCCollectionMode.Optimized);
                job.ProcessedDemos++;
            }
            catch (Exception ex)
            {
                job.FailedDemos++;
                Console.Error.WriteLine($"Error processing {Path.GetFileName(demoPath)}: {ex.Message}");
            }
        }

        // Rebuild aggregated profiles and compute matches
        job.CurrentDemo = "Aggregating profiles...";
        db.RebuildAggregatedProfiles();

        job.CurrentDemo = "Computing matches...";
        var profiles = db.GetAllAggregatedProfiles();
        var matches = SimilarityEngine.ComputeAllMatches(profiles);
        db.SaveMatches(matches);

        job.State = "done";
        job.CurrentDemo = "";
        processingLock.Release();
    });

    return Results.Ok(new { jobId });
});

// ── Reprocess all profiles from stored WAV files ───
app.MapPost("/api/reprocess", () =>
{
    if (speakerEmbedder == null)
        return Results.BadRequest(new { error = "Speaker embedding model not loaded" });

    if (!processingLock.Wait(0))
        return Results.Conflict(new { error = "Processing already in progress" });

    var jobId = Guid.NewGuid().ToString("N")[..8];
    var job = new JobStatus { Id = jobId, State = "processing" };
    jobs[jobId] = job;

    _ = Task.Run(() =>
    {
        try
        {
            var demoHashes = db.GetAllDemoHashes();
            job.TotalDemos = demoHashes.Count;
            Console.WriteLine($"Reprocessing {demoHashes.Count} demos from stored audio files...");

            foreach (var (demoId, fileHash) in demoHashes)
            {
                try
                {
                    job.CurrentDemo = fileHash[..Math.Min(12, fileHash.Length)] + "...";
                    var profileInfos = db.GetProfilesForDemo(demoId);

                    foreach (var (profileId, steamId, playerName, teamNumber) in profileInfos)
                    {
                        var playerAudioDir = Path.Combine(audioDir, fileHash, steamId.ToString());
                        if (!Directory.Exists(playerAudioDir)) continue;

                        var wavFiles = Directory.GetFiles(playerAudioDir, "*.wav");
                        if (wavFiles.Length == 0) continue;

                        // Read all WAV segments and concatenate PCM (48kHz)
                        var allSamples = new List<float>();
                        foreach (var wf in wavFiles.OrderBy(f => f))
                        {
                            try { allSamples.AddRange(AudioExtractor.ReadWavFile(wf)); }
                            catch { /* skip corrupt files */ }
                        }

                        if (allSamples.Count < 48000) continue; // need >= 1s

                        var pcm = allSamples.ToArray();
                        double speakSec = pcm.Length / 48000.0;
                        var profile = VoiceProfileBuilder.BuildProfile(speakerEmbedder, steamId, playerName ?? "", "", pcm, speakSec);

                        lock (db)
                        {
                            db.UpdateProfileEmbedding(profileId, profile.MfccEmbedding, profile.TotalFrames, profile.SpeakingSeconds);
                        }
                        job.PlayersFound++;
                    }

                    job.ProcessedDemos++;
                }
                catch (Exception ex)
                {
                    job.FailedDemos++;
                    Console.Error.WriteLine($"Reprocess error for demo {demoId}: {ex.Message}");
                }
            }

            // Rebuild aggregated profiles and matches
            job.CurrentDemo = "Aggregating profiles...";
            db.RebuildAggregatedProfiles();

            job.CurrentDemo = "Computing matches...";
            var profiles = db.GetAllAggregatedProfiles();
            var matches = SimilarityEngine.ComputeAllMatches(profiles);
            db.SaveMatches(matches);

            job.State = "done";
            job.CurrentDemo = "";
            Console.WriteLine($"Reprocessing complete. {job.ProcessedDemos} demos, {job.PlayersFound} profiles updated.");
        }
        catch (Exception ex)
        {
            job.State = "error";
            job.CurrentDemo = ex.Message;
            Console.Error.WriteLine($"Reprocess failed: {ex}");
        }
        finally
        {
            processingLock.Release();
        }
    });

    return Results.Ok(new { jobId });
});

// ── Job status ─────────────────────────────────────
app.MapGet("/api/jobs/{id}", (string id) =>
{
    return jobs.TryGetValue(id, out var job) ? Results.Ok(job) : Results.NotFound();
});

// ── Stats ──────────────────────────────────────────
app.MapGet("/api/stats", () =>
{
    return Results.Ok(new
    {
        demos = db.GetDemoCount(),
        players = db.GetProfileCount(),
        voiceMatches = db.GetMatchCount(SimilarityEngine.DefaultThreshold, true)
    });
});

// ── Demos (matches = CS2 games) ────────────────────
app.MapGet("/api/demos", () => Results.Ok(db.GetDemosWithPlayers()));

app.MapGet("/api/demos/{demoId}", (long demoId) =>
{
    var players = db.GetDemoPlayers(demoId, audioDir);
    return Results.Ok(players);
});

// ── Maps ───────────────────────────────────────────
app.MapGet("/api/maps", () => Results.Ok(db.GetDistinctMaps()));

// ── Matches ────────────────────────────────────────
app.MapGet("/api/matches", (float? threshold, bool? diffNames, string? map) =>
{
    var thr = threshold ?? SimilarityEngine.DefaultThreshold;
    var diff = diffNames ?? false;
    var matches = db.GetMatches(thr, diff);

    // Apply map filter in memory if specified
    if (!string.IsNullOrEmpty(map) && map != "All")
    {
        matches = matches.Where(m =>
        {
            var h1 = db.GetPlayerDemoHistory(m.SteamId1);
            var h2 = db.GetPlayerDemoHistory(m.SteamId2);
            var maps1 = h1.Select(x => x.MapName).ToHashSet();
            return h2.Any(x => maps1.Contains(x.MapName) && x.MapName == map);
        }).ToList();
    }

    return Results.Ok(matches.Select(m => new
    {
        steamId1 = m.SteamId1.ToString(),
        steamId2 = m.SteamId2.ToString(),
        names1 = m.Names1,
        names2 = m.Names2,
        similarity = m.Similarity,
        differentNames = m.DifferentNames
    }));
});

// ── Players list ───────────────────────────────────
app.MapGet("/api/players", (string? search, double? minSpeaking) =>
{
    List<AggregatedProfile> profiles;
    if (!string.IsNullOrWhiteSpace(search))
    {
        if (ulong.TryParse(search, out var sid))
        {
            var p = db.GetAggregatedProfile(sid);
            profiles = p != null ? new List<AggregatedProfile> { p } : new();
        }
        else
        {
            profiles = db.SearchByName(search);
        }
    }
    else
    {
        profiles = db.GetAllAggregatedProfiles();
    }

    if (minSpeaking.HasValue)
        profiles = profiles.Where(p => p.TotalSpeakingSeconds >= minSpeaking.Value).ToList();

    return Results.Ok(profiles.Select(p => new
    {
        steamId = p.SteamId.ToString(),
        names = p.KnownNames,
        demos = p.DemoCount,
        speakingSeconds = p.TotalSpeakingSeconds,
        totalFrames = p.TotalFrames
    }));
});

// ── Player detail ──────────────────────────────────
app.MapGet("/api/players/{steamId}", (string steamId) =>
{
    if (!ulong.TryParse(steamId, out var sid)) return Results.BadRequest("Invalid SteamID");

    var profile = db.GetAggregatedProfile(sid);
    if (profile == null) return Results.NotFound();

    var history = db.GetPlayerDemoHistory(sid);

    return Results.Ok(new
    {
        steamId = profile.SteamId.ToString(),
        names = profile.KnownNames,
        demos = profile.DemoCount,
        speakingSeconds = profile.TotalSpeakingSeconds,
        totalFrames = profile.TotalFrames,
        appearances = history.Select(h => new
        {
            demoId = h.DemoId,
            demo = Path.GetFileName(h.DemoFile),
            map = h.MapName,
            name = h.PlayerName,
            speakingSeconds = h.SpeakingSeconds,
            date = h.ProcessedAt.ToString("yyyy-MM-dd HH:mm")
        })
    });
});

// ── Find similar voices ────────────────────────────
app.MapGet("/api/players/{steamId}/similar", (string steamId, float? threshold) =>
{
    if (!ulong.TryParse(steamId, out var sid)) return Results.BadRequest("Invalid SteamID");

    var target = db.GetAggregatedProfile(sid);
    if (target == null) return Results.NotFound();

    var all = db.GetAllAggregatedProfiles();
    var thr = threshold ?? 0.70f;
    var similar = SimilarityEngine.FindSimilarToProfile(target, all, thr);

    return Results.Ok(similar.Select(s => new
    {
        steamId = s.Profile.SteamId.ToString(),
        names = s.Profile.KnownNames,
        similarity = s.Similarity,
        demos = s.Profile.DemoCount,
        speakingSeconds = s.Profile.TotalSpeakingSeconds,
        differentNames = !target.KnownNames.Any(tn =>
            s.Profile.KnownNames.Any(sn => string.Equals(tn, sn, StringComparison.OrdinalIgnoreCase)))
    }));
});

// ── Player audio files ─────────────────────────────
app.MapGet("/api/players/{steamId}/audio", (string steamId) =>
{
    if (!ulong.TryParse(steamId, out var sid)) return Results.BadRequest("Invalid SteamID");
    return Results.Ok(db.GetPlayerAudioFiles(sid, audioDir));
});

// ── Compare two players ────────────────────────────
app.MapGet("/api/compare/{steamId1}/{steamId2}", (string steamId1, string steamId2) =>
{
    if (!ulong.TryParse(steamId1, out var sid1) || !ulong.TryParse(steamId2, out var sid2))
        return Results.BadRequest("Invalid SteamID");

    var p1 = db.GetAggregatedProfile(sid1);
    var p2 = db.GetAggregatedProfile(sid2);
    if (p1 == null || p2 == null) return Results.NotFound();

    var similarity = SimilarityEngine.CompareTwo(p1, p2);
    var sharedDemos = db.GetSharedDemos(sid1, sid2);
    var perDemoSim = db.GetPerDemoSimilarity(sid1, sid2);
    var audio1 = db.GetPlayerAudioFiles(sid1, audioDir);
    var audio2 = db.GetPlayerAudioFiles(sid2, audioDir);

    return Results.Ok(new
    {
        player1 = new { steamId = p1.SteamId.ToString(), names = p1.KnownNames, demos = p1.DemoCount, speakingSeconds = p1.TotalSpeakingSeconds },
        player2 = new { steamId = p2.SteamId.ToString(), names = p2.KnownNames, demos = p2.DemoCount, speakingSeconds = p2.TotalSpeakingSeconds },
        similarity,
        sharedDemos,
        perDemoSimilarity = perDemoSim,
        audio1,
        audio2
    });
});

// ── Clusters (identity groups with confidence) ─────
app.MapGet("/api/clusters", (float? threshold) =>
{
    var thr = threshold ?? SimilarityEngine.DefaultThreshold;
    var profiles = db.GetAllAggregatedProfiles();
    var clusters = SimilarityEngine.ComputeIdentityClusters(profiles, thr);

    return Results.Ok(clusters.Select((c, i) => new
    {
        id = i + 1,
        memberCount = c.Members.Count,
        confidenceTier = c.ConfidenceTier,
        minSimilarity = c.MinSimilarity,
        avgSimilarity = c.AvgSimilarity,
        members = c.Members.Select(m => new
        {
            steamId = m.SteamId.ToString(),
            names = m.KnownNames,
            demos = m.DemoCount,
            speakingSeconds = m.TotalSpeakingSeconds
        }),
        pairSimilarities = c.PairSimilarities.Select(ps => new
        {
            steamId1 = ps.SteamId1.ToString(),
            steamId2 = ps.SteamId2.ToString(),
            similarity = ps.Similarity
        }),
        allNames = c.Members.SelectMany(m => m.KnownNames).Distinct().ToList()
    }));
});

// ── Similarity histogram ───────────────────────────
app.MapGet("/api/histogram", () =>
{
    var profiles = db.GetAllAggregatedProfiles();
    var histogram = SimilarityEngine.GetSimilarityHistogram(profiles);
    return Results.Ok(histogram.Select(h => new { binStart = h.BinStart, count = h.Count }));
});

// ── Diagnostic: per-segment embedding validation ───
app.MapGet("/api/diag/segment-test", () =>
{
    if (speakerEmbedder == null)
        return Results.BadRequest(new { error = "Speaker model not loaded" });

    var demoHashes = db.GetAllDemoHashes();
    if (demoHashes.Count == 0)
        return Results.NotFound(new { error = "No demos" });

    // For each player, compute embeddings of individual WAV segments (grouping small ones)
    var (demoId, fileHash) = demoHashes[0];
    var profileInfos = db.GetProfilesForDemo(demoId);

    const int minSegmentBytes = 48000 * 2; // ~1s at 48kHz (16-bit)
    const int targetChunkSamples = 48000 * 5; // ~5s chunks for reliable embeddings

    var playerEmbeddings = new Dictionary<string, List<(string label, float[] emb)>>();
    var playerNames = new Dictionary<string, string>();

    foreach (var (profileId, steamId, playerName, _) in profileInfos)
    {
        var playerAudioDir = Path.Combine(audioDir, fileHash, steamId.ToString());
        if (!Directory.Exists(playerAudioDir)) continue;

        var wavFiles = Directory.GetFiles(playerAudioDir, "*.wav").OrderBy(f => f).ToArray();
        if (wavFiles.Length == 0) continue;

        var key = steamId.ToString();
        playerNames[key] = playerName ?? key;
        playerEmbeddings[key] = new List<(string, float[])>();

        // Group WAV segments into ~5s chunks for more reliable embeddings
        var currentChunk = new List<float>();
        int chunkIdx = 0;

        foreach (var wf in wavFiles)
        {
            try
            {
                var samples = AudioExtractor.ReadWavFile(wf);
                if (samples.Length < 4800) continue; // skip tiny fragments
                currentChunk.AddRange(samples);

                if (currentChunk.Count >= targetChunkSamples)
                {
                    var emb = speakerEmbedder.GetEmbedding(currentChunk.ToArray());
                    if (emb.Any(v => v != 0))
                        playerEmbeddings[key].Add(($"chunk_{chunkIdx}", emb));
                    currentChunk.Clear();
                    chunkIdx++;
                }
            }
            catch { }
        }
        // Last chunk
        if (currentChunk.Count >= 48000)
        {
            var emb = speakerEmbedder.GetEmbedding(currentChunk.ToArray());
            if (emb.Any(v => v != 0))
                playerEmbeddings[key].Add(($"chunk_{chunkIdx}", emb));
        }
    }

    // Compute intra-player similarities (same person, different segments)
    var intraResults = new List<object>();
    foreach (var (key, embList) in playerEmbeddings)
    {
        if (embList.Count < 2) continue;
        var sims = new List<float>();
        for (int i = 0; i < embList.Count; i++)
            for (int j = i + 1; j < embList.Count; j++)
                sims.Add(SimilarityEngine.CosineSimilarity(embList[i].emb, embList[j].emb));

        intraResults.Add(new
        {
            steamId = key,
            name = playerNames[key],
            segments = embList.Count,
            pairs = sims.Count,
            min = sims.Count > 0 ? Math.Round(sims.Min(), 4) : 0,
            max = sims.Count > 0 ? Math.Round(sims.Max(), 4) : 0,
            avg = sims.Count > 0 ? Math.Round(sims.Average(), 4) : 0
        });
    }

    // Compute inter-player similarities (different persons, random segments)
    var interSims = new List<float>();
    var keys = playerEmbeddings.Keys.ToList();
    for (int i = 0; i < keys.Count; i++)
        for (int j = i + 1; j < keys.Count; j++)
        {
            var embsA = playerEmbeddings[keys[i]];
            var embsB = playerEmbeddings[keys[j]];
            // Compare first segment of each
            if (embsA.Count > 0 && embsB.Count > 0)
            {
                for (int a = 0; a < Math.Min(2, embsA.Count); a++)
                    for (int b = 0; b < Math.Min(2, embsB.Count); b++)
                        interSims.Add(SimilarityEngine.CosineSimilarity(embsA[a].emb, embsB[b].emb));
            }
        }

    return Results.Ok(new
    {
        demo = fileHash[..12] + "...",
        intraPlayer = intraResults,
        interPlayer = new
        {
            pairs = interSims.Count,
            min = interSims.Count > 0 ? Math.Round(interSims.Min(), 4) : 0,
            max = interSims.Count > 0 ? Math.Round(interSims.Max(), 4) : 0,
            avg = interSims.Count > 0 ? Math.Round(interSims.Average(), 4) : 0
        },
        verdict = intraResults.Any() && interSims.Any()
            ? (((double)intraResults.Min(x => ((dynamic)x).min) > interSims.Max())
                ? "PASS: intra-player min > inter-player max — embeddings are discriminative"
                : $"GAP: intra-player min={(double)intraResults.Min(x => ((dynamic)x).min):F3}, inter-player max={interSims.Max():F3}")
            : "Insufficient data"
    });
});

// ── Clear data ─────────────────────────────────────
app.MapDelete("/api/data", () =>
{
    db.ClearAll();
    // Clean uploads
    foreach (var f in Directory.GetFiles(uploadsDir))
        File.Delete(f);
    return Results.Ok(new { message = "All data cleared" });
});

// ── Fallback: serve index.html ─────────────────────
app.MapFallback(async ctx =>
{
    ctx.Response.ContentType = "text/html";
    await ctx.Response.SendFileAsync(Path.Combine(app.Environment.WebRootPath, "index.html"));
});

app.Run();

// ── Record type (must be after top-level statements) ──
public record JobStatus
{
    public string Id { get; init; } = "";
    public string State { get; set; } = "queued";
    public int TotalDemos { get; set; }
    public int ProcessedDemos { get; set; }
    public int PlayersFound { get; set; }
    public int FailedDemos { get; set; }
    public string CurrentDemo { get; set; } = "";
    public string? Error { get; set; }
}
