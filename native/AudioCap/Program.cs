// AudioCap: WASAPI capture helper for ClipForge.
// Commands:
//   list                         -> JSON list of render/capture endpoints on stdout
//   capture --pipe NAME --source loopback|mic [--device ID]
//       Serves 48 kHz stereo f32le PCM on the named pipe NAME. Silence is inserted whenever the
//       device delivers no data (WASAPI loopback goes quiet when nothing plays), so the
//       stream stays on a wall clock and remains in sync with video.
// Exits when stdin closes (parent died) or the pipe client disconnects.
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text.Json;
using NAudio.CoreAudioApi;
using NAudio.Wave;

static class Program
{
    const int Rate = 48000, Channels = 2, FrameBytes = 8; // f32 stereo

    static int Main(string[] args)
    {
        try
        {
            if (args.Length > 0 && args[0] == "list") { List(); return 0; }
            if (args.Length > 0 && args[0] == "capture") return Capture(args);
            Console.Error.WriteLine("usage: AudioCap list | capture --pipe NAME --source loopback|mic [--device ID]");
            return 2;
        }
        catch (Exception e) { Console.Error.WriteLine("fatal: " + e.Message); return 1; }
    }

    static void List()
    {
        using var en = new MMDeviceEnumerator();
        string? defR = null, defC = null;
        try { defR = en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia).ID; } catch { }
        try { defC = en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications).ID; } catch { }
        var list = new List<object>();
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            list.Add(new { id = d.ID, name = d.FriendlyName, kind = "render", isDefault = d.ID == defR });
        foreach (var d in en.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            list.Add(new { id = d.ID, name = d.FriendlyName, kind = "capture", isDefault = d.ID == defC });
        Console.WriteLine(JsonSerializer.Serialize(list));
    }

    static string? Arg(string[] a, string k) { var i = Array.IndexOf(a, k); return i >= 0 && i + 1 < a.Length ? a[i + 1] : null; }

    static int Capture(string[] args)
    {
        var pipeName = Arg(args, "--pipe") ?? throw new ArgumentException("--pipe required");
        var source = Arg(args, "--source") ?? "loopback";
        var deviceId = Arg(args, "--device");
        using var en = new MMDeviceEnumerator();
        MMDevice dev = !string.IsNullOrEmpty(deviceId) ? en.GetDevice(deviceId)
            : source == "mic" ? en.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications)
            : en.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);

        WasapiCapture cap = source == "mic" ? new WasapiCapture(dev, true, 20) : new WasapiLoopbackCapture(dev);
        var inFmt = cap.WaveFormat;
        Console.Error.WriteLine($"device: {dev.FriendlyName} format: {inFmt}");

        using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.Out, 1, PipeTransmissionMode.Byte, PipeOptions.None, 0, 1 << 20);
        Console.Out.WriteLine("ready"); Console.Out.Flush();

        // Parent watchdog: when stdin closes, exit.
        new Thread(() => { try { while (Console.In.Read() >= 0) { } } catch { } Environment.Exit(0); }) { IsBackground = true }.Start();

        pipe.WaitForConnection();
        Console.Error.WriteLine("client connected");

        var queue = new BlockingCollection<float[]>(256);
        cap.DataAvailable += (_, e) =>
        {
            if (e.BytesRecorded == 0) return;
            var f = Convert(e.Buffer, e.BytesRecorded, inFmt);
            if (f.Length > 0) queue.TryAdd(f);
        };
        var stopped = new ManualResetEventSlim();
        string? stopError = null;
        cap.RecordingStopped += (_, e) => { stopError = e.Exception?.Message; stopped.Set(); };

        cap.StartRecording();
        var clock = Stopwatch.StartNew();
        long framesWritten = 0;
        var buf = new byte[Rate * FrameBytes]; // up to 1 s
        try
        {
            while (!stopped.IsSet)
            {
                if (queue.TryTake(out var samples, 10))
                {
                    WriteFloats(pipe, samples, buf);
                    framesWritten += samples.Length / Channels;
                }
                // Keep the stream on the wall clock: pad silence if we fall more than 40 ms behind,
                // drop a buffer if the device runs more than 200 ms ahead (clock drift).
                long expected = clock.ElapsedTicks * Rate / Stopwatch.Frequency;
                long behind = expected - framesWritten;
                if (behind > Rate * 40 / 1000 && queue.Count == 0)
                {
                    int n = (int)Math.Min(behind, Rate);
                    Array.Clear(buf, 0, n * FrameBytes);
                    pipe.Write(buf, 0, n * FrameBytes);
                    framesWritten += n;
                }
                else if (-behind > Rate / 5) queue.TryTake(out _); // drop a buffer to resync
            }
            Console.Error.WriteLine("device stopped: " + (stopError ?? "unknown"));
            return 3;
        }
        catch (IOException) { Console.Error.WriteLine("pipe closed"); return 0; }
        finally { try { cap.StopRecording(); } catch { } cap.Dispose(); }
    }

    static void WriteFloats(Stream s, float[] f, byte[] buf)
    {
        int bytes = f.Length * 4;
        var b = bytes <= buf.Length ? buf : new byte[bytes];
        Buffer.BlockCopy(f, 0, b, 0, bytes);
        s.Write(b, 0, bytes);
    }

    // Convert the device mix format to 48 kHz stereo float (linear resampling when needed).
    static float[] Convert(byte[] data, int count, WaveFormat fmt)
    {
        int ch = fmt.Channels;
        int frames;
        float[] st;
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat ||
            (fmt is WaveFormatExtensible x && x.SubFormat == NAudio.Dmo.AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT);
        if (isFloat && fmt.BitsPerSample == 32)
        {
            frames = count / (4 * ch); st = new float[frames * 2];
            for (int i = 0; i < frames; i++)
            {
                float l = BitConverter.ToSingle(data, i * ch * 4);
                st[i * 2] = l; st[i * 2 + 1] = ch > 1 ? BitConverter.ToSingle(data, (i * ch + 1) * 4) : l;
            }
        }
        else if (fmt.BitsPerSample == 16)
        {
            frames = count / (2 * ch); st = new float[frames * 2];
            for (int i = 0; i < frames; i++)
            {
                float l = BitConverter.ToInt16(data, i * ch * 2) / 32768f;
                st[i * 2] = l; st[i * 2 + 1] = ch > 1 ? BitConverter.ToInt16(data, (i * ch + 1) * 2) / 32768f : l;
            }
        }
        else if (fmt.BitsPerSample == 24 || fmt.BitsPerSample == 32)
        {
            int bps = fmt.BitsPerSample / 8;
            frames = count / (bps * ch); st = new float[frames * 2];
            for (int i = 0; i < frames; i++)
                for (int c = 0; c < 2; c++)
                {
                    int o = (i * ch + Math.Min(c, ch - 1)) * bps;
                    int v = bps == 3 ? (data[o] << 8 | data[o + 1] << 16 | data[o + 2] << 24) : BitConverter.ToInt32(data, o);
                    st[i * 2 + c] = v / 2147483648f;
                }
        }
        else return Array.Empty<float>();
        if (fmt.SampleRate == Rate) return st;
        double ratio = (double)fmt.SampleRate / Rate;
        int outFrames = (int)(frames / ratio);
        var res = new float[outFrames * 2];
        for (int i = 0; i < outFrames; i++)
        {
            double p = i * ratio; int a = (int)p; int b = Math.Min(a + 1, frames - 1); float t = (float)(p - a);
            res[i * 2] = st[a * 2] * (1 - t) + st[b * 2] * t;
            res[i * 2 + 1] = st[a * 2 + 1] * (1 - t) + st[b * 2 + 1] * t;
        }
        return res;
    }
}
