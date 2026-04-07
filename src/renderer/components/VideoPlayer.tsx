import React, { useEffect, useRef } from 'react';

const MIME = 'video/mp4; codecs="avc1.42E01E"';

export default function VideoPlayer(): React.ReactElement {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let mediaSource: MediaSource | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];

    function pump() {
      if (!sourceBuffer || sourceBuffer.updating) return;
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

        mediaSource = new MediaSource();
        const video = videoRef.current;
        if (!video) return;
        video.src = URL.createObjectURL(mediaSource);

        mediaSource.addEventListener('sourceopen', () => {
          if (!mediaSource) return;
          sourceBuffer = mediaSource.addSourceBuffer(MIME);
          sourceBuffer.mode = 'sequence';
          sourceBuffer.addEventListener('updateend', pump);
          pump();
        });

        ws = new WebSocket(`ws://127.0.0.1:${port}`);
        ws.binaryType = 'arraybuffer';
        ws.onmessage = (event) => {
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
      }
      if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch {
          /* ignore */
        }
      }
      sourceBuffer = null;
      mediaSource = null;
    };
  }, []);

  return (
    <div className="video-stage">
      <video ref={videoRef} autoPlay muted playsInline />
    </div>
  );
}
