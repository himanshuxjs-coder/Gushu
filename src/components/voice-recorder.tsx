import { useState, useRef, useEffect } from "react";
import { Mic, Square, Trash2, Send, Loader2, Play, Pause } from "lucide-react";
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

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        setRecordedBlob(blob);
        const url = URL.createObjectURL(blob);
        setPreviewUrl(url);
        
        // Stop all tracks
        stream.getTracks().forEach(track => track.stop());
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
      onCancel();
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
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
    <div className="flex w-full items-center gap-3 rounded-2xl border border-border/70 bg-card/90 p-2 shadow-[0_16px_50px_rgba(0,0,0,0.18)] backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2">
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
