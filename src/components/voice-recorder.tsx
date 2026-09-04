import { useState, useRef, useEffect } from "react";
import { Mic, Square, Trash2, Send, Loader2, Play, Pause, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface VoiceRecorderProps {
  onSend: (blob: Blob) => Promise<void>;
  onCancel: () => void;
}

export function VoiceRecorder({ onSend, onCancel }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [selectedMicrophoneId, setSelectedMicrophoneId] = useState("");
  const [permissionError, setPermissionError] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const restartWithMicrophoneRef = useRef(false);
  const selectedMicrophoneRef = useRef("");
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const isDesktop = typeof window !== "undefined" && !window.matchMedia("(max-width: 768px)").matches;

  const loadMicrophones = async (activeDeviceId?: string) => {
    if (!isDesktop || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const available = devices.filter((device) => device.kind === "audioinput");
    setMicrophones(available);
    const activeMicrophone = activeDeviceId && available.find((device) => device.deviceId === activeDeviceId);
    if (!selectedMicrophoneId && available[0]) {
      const deviceId = activeMicrophone?.deviceId ?? available[0].deviceId;
      selectedMicrophoneRef.current = deviceId;
      setSelectedMicrophoneId(deviceId);
    }
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startRecording = async () => {
    try {
      setPermissionError(false);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMicrophoneRef.current ? { deviceId: { exact: selectedMicrophoneRef.current } } : true,
      });
      await loadMicrophones(stream.getAudioTracks()[0]?.getSettings().deviceId);
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());

        if (restartWithMicrophoneRef.current) {
          restartWithMicrophoneRef.current = false;
          setRecordedBlob(null);
          setPreviewUrl(null);
          setPlaybackTime(0);
          setAudioDuration(0);
          void startRecording();
          return;
        }

        setRecordedBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
      };

      mediaRecorder.start();
      setIsRecording(true);
      setDuration(0);
      timerRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Failed to start recording:", err);
      toast.error("Microphone access denied or not available");
      if (isDesktop) setPermissionError(true);
      else onCancel();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const changeMicrophone = (deviceId: string) => {
    selectedMicrophoneRef.current = deviceId;
    setSelectedMicrophoneId(deviceId);
    if (isRecording && mediaRecorderRef.current?.state === "recording") {
      restartWithMicrophoneRef.current = true;
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    }
  };

  const handleSend = async () => {
    if (!recordedBlob) return;
    setBusy(true);
    try {
      await onSend(recordedBlob);
    } catch (err) {
      console.error("Failed to send voice note:", err);
      toast.error("Failed to send voice note");
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = () => {
    setRecordedBlob(null);
    setPreviewUrl(null);
    setDuration(0);
    setPlaybackTime(0);
    setAudioDuration(0);
    setIsPlaying(false);
    if (!isRecording) onCancel();
  };

  const togglePlayback = async () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        try {
          await audioRef.current.play();
        } catch {
          toast.error("Unable to play recording");
        }
      }
    }
  };

  const seekPlayback = (value: number) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = value;
    setPlaybackTime(value);
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  useEffect(() => {
    // Start recording automatically when component mounts
    startRecording();
  }, []);

  return (
    <div className="relative flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card/90 p-2 shadow-[0_16px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2">
      <div className="flex min-h-12 flex-1 items-center gap-3 rounded-xl bg-muted/40 px-3 py-2">
        {isRecording ? (
          <>
            <div className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500"></span>
            </div>
            <span className="min-w-10 text-sm font-semibold tabular-nums text-foreground">
              {formatDuration(duration)}
            </span>
            <div className="flex-1 overflow-hidden">
              <div className="flex h-8 items-center justify-center gap-1">
                {[...Array(28)].map((_, i) => (
                  <div 
                    key={i} 
                    className="w-1 rounded-full bg-primary/50 animate-pulse"
                    style={{ 
                      height: `${8 + ((i * 13) % 20)}px`,
                      animationDelay: `${i * 0.05}s`
                    }} 
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <Button
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={togglePlayback}
            >
              {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <span className="min-w-10 text-xs font-semibold tabular-nums text-foreground">
              {formatDuration(playbackTime)}
            </span>
            <div className="relative flex flex-1 items-center">
              <div className="absolute inset-x-0 h-1.5 rounded-full bg-primary/15" />
              <div
                className="pointer-events-none absolute left-0 h-1.5 rounded-full brand-gradient"
                style={{ width: `${audioDuration ? (playbackTime / audioDuration) * 100 : 0}%` }}
              />
              <input
                type="range"
                min="0"
                max={audioDuration || 0}
                step="0.01"
                value={Math.min(playbackTime, audioDuration || 0)}
                onChange={(event) => seekPlayback(Number(event.target.value))}
                disabled={!audioDuration}
                aria-label="Recording playback position"
                className="relative z-10 h-5 w-full cursor-pointer appearance-none bg-transparent accent-primary"
              />
            </div>
            <span className="min-w-10 text-right text-xs tabular-nums text-muted-foreground">
              {formatDuration(audioDuration || duration)}
            </span>
          </>
        )}
      </div>

      {isDesktop && microphones.length > 0 && (
        <label className="flex shrink-0 items-center gap-1.5 rounded-xl border border-border/70 bg-muted/60 px-2.5 py-2 text-muted-foreground shadow-sm transition-colors focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20">
          <Settings2 className="size-3.5" />
          <select
            value={selectedMicrophoneId}
            onChange={(event) => changeMicrophone(event.target.value)}
            className="max-w-40 cursor-pointer appearance-none bg-background px-1.5 py-1 text-[11px] font-medium text-foreground outline-none focus-visible:ring-1 focus-visible:ring-primary"
            aria-label="Select microphone"
          >
            {microphones.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId} className="bg-neutral-950 text-white">
                {device.label || `Microphone ${index + 1}`}
              </option>
            ))}
          </select>
        </label>
      )}

      {permissionError && (
        <button
          type="button"
          onClick={() => void startRecording()}
          className="absolute bottom-full left-0 mb-2 rounded-xl border border-red-400/30 bg-card px-3 py-2 text-xs text-red-300 shadow-xl"
        >
          Allow microphone access and try again
        </button>
      )}

      <audio 
        ref={audioRef} 
        src={previewUrl || ""} 
        onLoadedMetadata={(event) => setAudioDuration(event.currentTarget.duration || 0)}
        onTimeUpdate={(event) => setPlaybackTime(event.currentTarget.currentTime)}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          setIsPlaying(false);
          setPlaybackTime(0);
        }}
        className="hidden"
      />

      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="size-10 text-muted-foreground hover:text-destructive"
          onClick={handleDiscard}
          disabled={busy}
        >
          <Trash2 className="size-5" />
        </Button>
        
        {isRecording ? (
          <Button
            size="icon"
            className="size-10 rounded-full bg-red-500 hover:bg-red-600"
            onClick={stopRecording}
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-10 rounded-full brand-gradient"
            onClick={handleSend}
            disabled={busy || !recordedBlob}
          >
            {busy ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Send className="size-5" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
