namespace Cs2VoiceMatcher.Core
{
    // ── Voice fingerprinting models ──────────────────────────────────────

    public class VoiceProfile
    {
        public long ProfileId { get; set; }
        public ulong SteamId { get; set; }
        public string? PlayerName { get; set; }
        public int TeamNumber { get; set; }
        public string DemoFile { get; set; } = "";
        public long DemoId { get; set; }
        public float[] MfccEmbedding { get; set; } = Array.Empty<float>();
        public float[] MfccStdDev { get; set; } = Array.Empty<float>();
        public int TotalFrames { get; set; }
        public double SpeakingSeconds { get; set; }
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    }

    public class AggregatedProfile
    {
        public ulong SteamId { get; set; }
        public List<string> KnownNames { get; set; } = new();
        public float[] MfccEmbedding { get; set; } = Array.Empty<float>();
        public int TotalFrames { get; set; }
        public double TotalSpeakingSeconds { get; set; }
        public int DemoCount { get; set; }
    }

    public class VoiceMatch
    {
        public long MatchId { get; set; }
        public ulong SteamId1 { get; set; }
        public ulong SteamId2 { get; set; }
        public string Names1 { get; set; } = "";
        public string Names2 { get; set; } = "";
        public float Similarity { get; set; }
        public bool DifferentNames { get; set; }
        public DateTime ComputedAt { get; set; } = DateTime.UtcNow;
    }

    // ── Player / demo appearance ─────────────────────────────────────────

    public class PlayerDemoAppearance
    {
        public long DemoId { get; set; }
        public string DemoFile { get; set; } = "";
        public string? MapName { get; set; }
        public string PlayerName { get; set; } = "";
        public double SpeakingSeconds { get; set; }
        public int TotalFrames { get; set; }
        public DateTime ProcessedAt { get; set; }
    }

    // ── Batch processing models ──────────────────────────────────────────

    public class DemoInfo
    {
        public string FilePath { get; set; } = "";
        public string FileName => Path.GetFileName(FilePath);
        public string? FileHash { get; set; }
        public string? MapName { get; set; }
        public string? HostName { get; set; }
        public int PlayerCount { get; set; }
        public DemoStatus Status { get; set; } = DemoStatus.Queued;
        public string? ErrorMessage { get; set; }
    }

    public enum DemoStatus
    {
        Queued,
        Processing,
        Done,
        Skipped,
        Error
    }

    public class BatchProgressInfo
    {
        public int TotalDemos { get; set; }
        public int ProcessedDemos { get; set; }
        public int SkippedDemos { get; set; }
        public int FailedDemos { get; set; }
        public string CurrentDemoName { get; set; } = "";
        public int TotalPlayersFound { get; set; }
        public BatchPhase Phase { get; set; } = BatchPhase.Idle;
        public TimeSpan Elapsed { get; set; }
    }

    public enum BatchPhase
    {
        Idle,
        Hashing,
        Parsing,
        ComputingFingerprints,
        Matching,
        Complete
    }

    // ── Audio extraction data container ──────────────────────────────────

    public class PlayerVoiceData
    {
        public ulong SteamId { get; set; }
        public string? PlayerName { get; set; }
        public int TeamNumber { get; set; } // 2=T, 3=CT
        public List<float[]> PcmSegments { get; set; } = new();
        public double TotalDurationSeconds { get; set; }
        public string? MapName { get; set; }
        public string? HostName { get; set; }
        public List<string> AudioFiles { get; set; } = new();
    }

    // ── Identity clustering models ───────────────────────────────────────

    public class IdentityCluster
    {
        public List<AggregatedProfile> Members { get; set; } = new();
        public List<PairSimilarity> PairSimilarities { get; set; } = new();
        public float MinSimilarity { get; set; }
        public float AvgSimilarity { get; set; }
        /// <summary>Confidence tier: "high" (>0.90), "medium" (0.80-0.90), "low" (0.70-0.80), "uncertain" (&lt;0.70)</summary>
        public string ConfidenceTier { get; set; } = "uncertain";
    }

    public class PairSimilarity
    {
        public ulong SteamId1 { get; set; }
        public ulong SteamId2 { get; set; }
        public float Similarity { get; set; }
    }
}
