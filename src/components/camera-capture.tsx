import { useState, useRef, useEffect } from "react";
import { Camera, RefreshCcw, X, Send, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CameraCaptureProps {
  onCapture: (blob: Blob) => Promise<void>;
  onClose: () => void;
}

export function CameraCapture({ onCapture, onClose }: CameraCaptureProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [capturedBlob, setCapturedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [busy, setBusy] = useState(false);
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const startCamera = async () => {
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      
      const newStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false
      });
      
      setStream(newStream);
      if (videoRef.current) {
        videoRef.current.srcObject = newStream;
      }
    } catch (err) {
      console.error("Failed to start camera:", err);
      toast.error("Camera access denied or not available");
      onClose();
    }
  };

  useEffect(() => {
    startCamera();
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [facingMode]);

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (blob) {
            setCapturedBlob(blob);
            setPreviewUrl(URL.createObjectURL(blob));
            // Stop camera after capture
            if (stream) {
              stream.getTracks().forEach(track => track.stop());
              setStream(null);
            }
          }
        }, "image/jpeg", 0.9);
      }
    }
  };

  const handleSend = async () => {
    if (!capturedBlob) return;
    setBusy(true);
    try {
      await onCapture(capturedBlob);
    } catch (err) {
      console.error("Failed to send photo:", err);
      toast.error("Failed to send photo");
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
    setFacingMode(prev => prev === "user" ? "environment" : "user");
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white md:rounded-3xl md:inset-4 md:shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between p-4">
        <h3 className="text-sm font-medium">Capture Photo</h3>
        <Button size="icon" variant="ghost" onClick={onClose} className="text-white hover:bg-white/10">
          <X className="size-6" />
        </Button>
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
            />
            <div className="absolute bottom-10 left-0 right-0 flex items-center justify-center gap-8">
              <Button
                size="icon"
                variant="ghost"
                onClick={toggleCamera}
                className="size-12 rounded-full bg-white/10 text-white hover:bg-white/20"
              >
                <RefreshCcw className="size-6" />
              </Button>
              <Button
                onClick={capturePhoto}
                className="size-20 rounded-full border-4 border-white bg-transparent p-0 hover:bg-white/20"
              >
                <div className="size-16 rounded-full bg-white" />
              </Button>
              <div className="size-12" /> {/* Spacer */}
            </div>
          </>
        ) : (
          <>
            {previewUrl && (
              <img
                src={previewUrl}
                alt="Captured"
                className="h-full w-full object-contain"
              />
            )}
            <div className="absolute bottom-10 left-0 right-0 flex items-center justify-center gap-4 px-4">
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
