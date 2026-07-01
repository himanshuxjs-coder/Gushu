import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCcw, X, Send, Trash2, Loader as Loader2, Zap, ZapOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CameraCaptureProps {
  onCapture: (blob: Blob, kind: "image") => Promise<void>;
  onClose: () => void;
}

export function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [busy, setBusy] = useState(false);
  const [flashOn, setFlashOn] = useState(false);
  const [torchAvailable, setTorchAvailable] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  const getConstraints = useCallback(
    (facing: "user" | "environment") => {
      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: facing,
          width: { ideal: 4096, max: 8192 },
          height: { ideal: 4096, max: 8192 },
          frameRate: { ideal: 60, max: 120 },
          aspectRatio: { ideal: 1.777 },
          brightness: { ideal: 50 },
          contrast: { ideal: 50 },
          saturation: { ideal: 50 },
        },
        audio: false,
      };
      return constraints;
    },
    [],
  );

  const startCamera = useCallback(async () => {
    try {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }

      const constraints = getConstraints(facingMode);
      const newStream = await navigator.mediaDevices.getUserMedia(constraints);

      const videoTrack = newStream.getVideoTracks()[0];
      const capabilities = videoTrack.getCapabilities?.() as any;
      if (capabilities?.torch) {
        setTorchAvailable(true);
      } else {
        setTorchAvailable(false);
      }

      setStream(newStream);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err: any) {
      toast.error(err?.message || "Camera access denied or not available");
      onClose();
    }
  }, [facingMode, getConstraints, onClose, stream]);

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode]);

  const toggleTorch = async () => {
    const videoTrack = stream?.getVideoTracks()[0];
    if (!videoTrack) return;
    try {
      const capabilities = videoTrack.getCapabilities?.() as any;
      if (!capabilities?.torch) return;
      const next = !flashOn;
      await (videoTrack as any).applyConstraints({ advanced: [{ torch: next }] });
      setFlashOn(next);
    } catch {
      toast.error("Flash not available on this device");
    }
  };

  const doFlash = () => {
    const el = flashRef.current;
    if (!el) return;
    el.style.opacity = "1";
    requestAnimationFrame(() => {
      el.style.transition = "opacity 150ms ease-out";
      el.style.opacity = "0";
    });
  };

  const capturePhoto = () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (facingMode === "user") {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    doFlash();

    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        setCapturedBlob(blob);
        setPreviewUrl(URL.createObjectURL(blob));
        if (stream) {
          stream.getTracks().forEach((track) => track.stop());
          setStream(null);
        }
      },
      "image/jpeg",
      0.95,
    );
  };

  const handleSend = async () => {
    if (!capturedBlob) return;
    setBusy(true);
    try {
      await onCapture(capturedBlob, "image");
    } catch (err: any) {
      toast.error(err?.message || "Failed to send");
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = () => {
    setCapturedBlob(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    startCamera();
  };

  const toggleCamera = () => {
    setFacingMode((prev) => (prev === "user" ? "environment" : "user"));
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white md:rounded-3xl md:inset-4 md:shadow-2xl overflow-hidden">
      <div ref={flashRef} className="pointer-events-none absolute inset-0 z-30 bg-white opacity-0" />

      <div className="flex items-center justify-between p-4 z-20">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full bg-white/10 hover:bg-white/20 transition-colors"
          >
            <X className="size-5" />
          </button>
          <h3 className="text-sm font-medium">Capture Photo</h3>
        </div>
      </div>

      <div className="relative flex-1 bg-neutral-900 overflow-hidden flex items-center justify-center">
        {!capturedBlob ? (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute inset-0 h-full w-full object-cover"
              style={{
                transform: facingMode === "user" ? "scaleX(-1)" : "none",
              }}
            />

            <div className="absolute bottom-10 left-0 right-0 z-20 flex items-center justify-center gap-6">
              {torchAvailable && (
                <button
                  onClick={toggleTorch}
                  className="grid size-12 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                  aria-label="Toggle flash"
                >
                  {flashOn ? <Zap className="size-5" /> : <ZapOff className="size-5" />}
                </button>
              )}

              <button
                onClick={toggleCamera}
                className="grid size-12 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                aria-label="Switch camera"
              >
                <RefreshCcw className="size-6" />
              </button>

              <button
                onClick={capturePhoto}
                className="size-20 rounded-full border-4 border-white bg-transparent transition-transform hover:scale-105 active:scale-95"
              >
                <div className="size-16 rounded-full bg-white" />
              </button>

              <div className="size-12" />
            </div>
          </>
        ) : (
          <>
            {previewUrl && (
              <img src={previewUrl} alt="Captured" className="h-full w-full object-contain" />
            )}

            <div className="absolute bottom-10 left-0 right-0 z-20 flex items-center justify-center gap-4 px-4">
              <Button
                variant="secondary"
                onClick={handleDiscard}
                className="flex-1 gap-2 rounded-xl"
                disabled={busy}
              >
                <Trash2 className="size-4" />
                Retake
              </Button>
              <Button
                onClick={handleSend}
                className="flex-1 gap-2 rounded-xl brand-gradient"
                disabled={busy}
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send
              </Button>
            </div>
          </>
        )}
      </div>
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
