import React, { useEffect, useRef } from 'react';

// MIME must be a valid AVC codec descriptor that Chromium MSE accepts;
// the listener (re-)encodes with -profile:v baseline -level 3.0 which
// produces avcC bytes 0x42/0xC0/0x1E. Chromium accepts both 42E01E and
// 42C01E for constrained baseline @ level 3.0; we use 42C01E because
// it matches the actual avcC bytes byte-for-byte (verified via
// out/inspect-mp4.mjs during the streaming bug investigation).
const MIME = 'video/mp4; codecs="avc1.42C01E"';

export default function VideoPlayer(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let mediaSource: MediaSource | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    let objectUrl: string | null = null;
    const queue: ArrayBuffer[] = [];

    function pump() {
      if (cancelled || !sourceBuffer || sourceBuffer.updating) return;
      const next = queue.shift();
      if (!next) return;
      try {
        sourceBuffer.appendBuffer(next);
      } catch (e) {
        console.error('VideoPlayer appendBuffer failed', e);
      }
    }

    async function init() {
      try {
        const port = await window.discdeck.getVideoPort();
        if (cancelled) return;

        if (!('MediaSource' in window) || !MediaSource.isTypeSupported(MIME)) {
          console.error('VideoPlayer: MIME not supported:', MIME);
          return;
        }

        // Capture the MediaSource in a local const so the sourceopen listener
        // can verify it is still the current one (defensive against React
        // double-mount, though StrictMode is currently disabled).
        const ms = new MediaSource();
        mediaSource = ms;

        const video = videoRef.current;
        if (!video) return;

        objectUrl = URL.createObjectURL(ms);
        video.src = objectUrl;

        ms.addEventListener('sourceopen', () => {
          if (cancelled || mediaSource !== ms || ms.readyState !== 'open') return;
          try {
            sourceBuffer = ms.addSourceBuffer(MIME);
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', pump);
            pump();
          } catch (e) {
            console.error('VideoPlayer addSourceBuffer failed', e);
          }
        });

        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event) => {
          if (cancelled) return;
          if (event.data instanceof ArrayBuffer) {
            queue.push(event.data);
            pump();
          }
        };
        ws.onerror = (err) => {
          console.warn('VideoPlayer ws error', err);
        };
      } catch (e) {
        console.error('VideoPlayer init failed', e);
      }
    }

    init();

    return () => {
      cancelled = true;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        ws = null;
      }
      // Drop the SourceBuffer reference first so any in-flight pump() call
      // bails out of the cancelled check cleanly.
      sourceBuffer = null;
      // Detach the MediaSource from the <video> element and revoke the
      // object URL so the MS transitions to 'closed' cleanly.
      const video = videoRef.current;
      if (video) {
        try {
          video.removeAttribute('src');
          video.load();
        } catch {
          /* ignore */
        }
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      mediaSource = null;
    };
  }, []);

  return (
    <div className="video-stage">
      <video ref={videoRef} autoPlay muted playsInline />
    </div>
  );
}
