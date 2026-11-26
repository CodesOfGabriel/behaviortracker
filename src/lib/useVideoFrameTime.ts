import { useEffect, useRef, useState, type RefObject } from "react";

/** Presentation time, rather than the infrequent timeupdate playback clock. */
export function useVideoFrameTime(ref: RefObject<HTMLVideoElement | null>, source?: string | null) {
  const [time, setTime] = useState<number | null>(null);
  const presented = useRef<number | null>(null);
  useEffect(() => {
    const video = ref.current;
    presented.current = null;
    setTime(null);
    if (!video || !source) return;
    let live = true, frame = 0, animation = 0;
    const native = typeof video.requestVideoFrameCallback === "function";
    const publish = (value: number | null) => {
      if (!live) return;
      presented.current = value;
      setTime(previous => previous === value ? previous : value);
    };
    const onFrame: VideoFrameRequestCallback = (_now, metadata) => {
      if (!live) return;
      if (!video.seeking) publish(metadata.mediaTime);
      frame = video.requestVideoFrameCallback(onFrame);
    };
    const fallback = () => {
      if (!live) return;
      if (!video.seeking && video.readyState >= 2) publish(video.currentTime);
      animation = requestAnimationFrame(fallback);
    };
    const seek = () => publish(null);
    const update = (event?: Event) => {
      if (video.seeking || video.readyState < 2) return;
      // WebKit can decode frame zero while a dialog is hidden without sending
      // a presentation callback until playback starts. Bootstrap only that
      // decoded initial frame. A paused seek can reuse the displayed frame and
      // emit seeked without a new presentation callback. Its decoded position
      // is then resolved to the source PTS by the frame lookup.
      if (!native || (video.paused && (event?.type === "seeked" || (presented.current == null && video.currentTime === 0)))) publish(video.currentTime);
    };
    video.addEventListener("seeking", seek);
    for (const event of ["loadeddata", "seeked", "timeupdate"]) video.addEventListener(event, update);
    if (native) frame = video.requestVideoFrameCallback(onFrame); else animation = requestAnimationFrame(fallback);
    update();
    return () => {
      live = false;
      if (native) video.cancelVideoFrameCallback(frame); else cancelAnimationFrame(animation);
      video.removeEventListener("seeking", seek);
      for (const event of ["loadeddata", "seeked", "timeupdate"]) video.removeEventListener(event, update);
    };
  }, [ref, source]);
  return { time, readPresentedTime: () => ref.current?.seeking ? null : presented.current };
}
