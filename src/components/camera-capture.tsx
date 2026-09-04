import { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCcw, X, Send, Trash2, Loader as Loader2, Zap, ZapOff, Settings2 } from "lucide-react";
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
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState("");
  const [permissionError, setPermissionError] = useState(false);
  const isDesktop = typeof window !== "undefined" && !window.matchMedia("(max-width: 768px)").matches;

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  const getConstraints = useCallback(
    (facing: "user" | "environment") => {
      const constraints: MediaStreamConstraints = {
        video: {
          ...(selectedCameraId ? { deviceId: { exact: selectedCameraId } } : { facingMode: facing }),
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
      setPermissionError(false);

      if (isDesktop && navigator.mediaDevices.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const available = devices.filter((device) => device.kind === "videoinput");
        setCameras(available);
        if (!selectedCameraId && available[0]) setSelectedCameraId(available[0].deviceId);
      }

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
      if (isDesktop) setPermissionError(true);
      else onClose();
    }
  }, [facingMode, getConstraints, onClose, selectedCameraId, stream]);

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode, selectedCameraId]);

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

      <div className="relative z-20 flex items-center justify-between border-b border-white/10 bg-black/30 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="grid size-9 place-items-center rounded-xl border border-white/10 bg-white/10 text-white/80 transition-all hover:border-white/25 hover:bg-white/20 hover:text-white active:scale-95"
            aria-label="Close camera"
          >
            <X className="size-4" />
          </button>
          <div>
            <h3 className="text-sm font-semibold tracking-tight">Capture Photo</h3>
            <p className="text-[10px] uppercase tracking-[0.18em] text-white/45">Studio capture</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDesktop && cameras.length > 0 ? (
            <label className="flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/10 px-2.5 py-2 text-white/70 backdrop-blur-xl">
              <Settings2 className="size-3.5" />
              <select
                value={selectedCameraId}
                onChange={(event) => setSelectedCameraId(event.target.value)}
                className="max-w-32 bg-transparent text-[10px] text-white outline-none"
                aria-label="Select camera"
              >
                {cameras.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId} className="bg-neutral-900 text-white">
                    {device.label || `Camera ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-full border border-white/10 bg-white/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-white/60">
              {facingMode === "user" ? "Front" : "Rear"}
            </div>
          )}
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-950">
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
            {permissionError && isDesktop && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/70 p-6 text-center backdrop-blur-md">
                <div className="max-w-xs rounded-2xl border border-white/10 bg-black/45 p-5 shadow-2xl">
                  <p className="text-sm font-semibold">Camera access is required</p>
                  <p className="mt-1 text-xs text-white/60">Allow camera access in your browser, then try again.</p>
                  <button
                    type="button"
                    onClick={() => void startCamera()}
                    className="mt-4 rounded-xl brand-gradient px-4 py-2 text-xs font-semibold text-white shadow-[0_0_20px_rgba(99,102,241,0.35)]"
                  >
                    Allow camera access
                  </button>
                </div>
              </div>
            )}
            <div className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_center,transparent_35%,rgba(0,0,0,0.52)_100%)]" />
            <div className="pointer-events-none absolute inset-8 z-10 rounded-[2rem] border border-white/15 sm:inset-14">
              <span className="absolute -left-px -top-px h-10 w-10 rounded-tl-2xl border-l-2 border-t-2 border-white/80" />
              <span className="absolute -right-px -top-px h-10 w-10 rounded-tr-2xl border-r-2 border-t-2 border-white/80" />
              <span className="absolute -bottom-px -left-px h-10 w-10 rounded-bl-2xl border-b-2 border-l-2 border-white/80" />
              <span className="absolute -bottom-px -right-px h-10 w-10 rounded-br-2xl border-b-2 border-r-2 border-white/80" />
            </div>

            <div className="absolute bottom-8 left-0 right-0 z-20 flex items-center justify-center gap-5 px-6">
              {torchAvailable && (
                <button
                  onClick={toggleTorch}
                  className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-black/25 text-white/80 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl transition-all hover:border-white/25 hover:bg-white/15 hover:text-white active:scale-95"
                  aria-label="Toggle flash"
                >
                  {flashOn ? <Zap className="size-5" /> : <ZapOff className="size-5" />}
                </button>
              )}

              <button
                onClick={toggleCamera}
                className="grid size-12 place-items-center rounded-2xl border border-white/10 bg-black/25 text-white/80 shadow-[0_8px_30px_rgba(0,0,0,0.25)] backdrop-blur-xl transition-all duration-300 hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/15 hover:text-white active:scale-95"
                aria-label="Switch camera"
              >
                <RefreshCcw className="size-6 transition-transform duration-300 hover:rotate-180" />
              </button>

              <button
                onClick={capturePhoto}
                className="group relative size-[5.5rem] rounded-full border-2 border-white/80 bg-white/10 p-1 shadow-[0_0_0_6px_rgba(255,255,255,0.12),0_0_35px_rgba(255,255,255,0.22)] backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
                aria-label="Take photo"
              >
                <div className="size-full rounded-full bg-white transition-transform duration-300 group-hover:scale-95" />
              </button>

              <div className="size-12" />
            </div>
          </>
        ) : (
          <>
            {previewUrl && (
              <img src={previewUrl} alt="Captured" className="h-full w-full object-contain p-6 sm:p-10" />
            )}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-transparent to-black/20" />

            <div className="absolute bottom-8 left-0 right-0 z-20 flex items-center justify-center gap-3 px-6">
              <Button
                variant="secondary"
                onClick={handleDiscard}
                className="h-11 flex-1 gap-2 rounded-xl border border-white/15 bg-white/10 text-white backdrop-blur-xl hover:bg-white/20"
                disabled={busy}
              >
                <Trash2 className="size-4" />
                Retake
              </Button>
              <Button
                onClick={handleSend}
                className="h-11 flex-1 gap-2 rounded-xl brand-gradient shadow-[0_0_24px_rgba(99,102,241,0.35)]"
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
