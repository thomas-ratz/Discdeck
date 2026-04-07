import React, { useEffect, useRef } from 'react';

const MIME = 'video/mp4; codecs="avc1.42E01E"';

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
        // can verify it's still the current one (guards against StrictMode
        // double-invoke where a later effect creates a new MS and detaches
        // this one, transitioning its readyState from 'open' to 'closed').
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
        ws.onclose = () => {
          console.info('VideoPlayer ws closed');
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
      // bails out of the readyState check cleanly.
      sourceBuffer = null;
      // Detach the MediaSource from the video element and revoke the object
      // URL. This transitions the MS readyState to 'closed' cleanly instead
      // of leaving it attached while a new effect invocation creates another.
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
