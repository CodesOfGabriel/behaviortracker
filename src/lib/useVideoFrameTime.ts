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
    let live = true, frame = 0, animation = 0, generation = 0;
    let seekPending = false, decodedPausedSeek = false;
    const native = typeof video.requestVideoFrameCallback === "function";
    const publish = (value: number | null) => {
      if (!live) return;
      presented.current = value;
      setTime(previous => previous === value ? previous : value);
    };
    const scheduleFrame = () => {
      const scheduledGeneration = generation;
      frame = video.requestVideoFrameCallback((_now, metadata) => {
        // Cancellation can arrive after a callback has already been queued.
        // A previous seek/source must never replace the current decoded frame.
        if (!live || scheduledGeneration !== generation) return;
        if (!seekPending && !video.seeking && !(video.paused && decodedPausedSeek)) publish(metadata.mediaTime);
        scheduleFrame();
      });
    };
    const fallback = () => {
      if (!live) return;
      if (!seekPending && !video.seeking && video.readyState >= 2) publish(video.currentTime);
      animation = requestAnimationFrame(fallback);
    };
    const cancelFrame = () => {generation++;video.cancelVideoFrameCallback(frame);};
    const seek = () => {
      seekPending = true;decodedPausedSeek = false;
      if (native) cancelFrame();
      publish(null);
    };
    const resume = () => {
      if (native && decodedPausedSeek) {cancelFrame();scheduleFrame();}
      decodedPausedSeek = false;
    };
    const update = (event?: Event) => {
      if (event?.type === "seeked" && !video.seeking) {
        const restart = seekPending;
        seekPending = false;
        if (native && restart) scheduleFrame();
      }
      if (seekPending || video.seeking || video.readyState < 2) return;
      // WebKit can decode frame zero while a dialog is hidden without sending
      // a presentation callback until playback starts. Bootstrap only that
      // decoded initial frame. A paused seek can reuse the displayed frame and
      // emit seeked without a new presentation callback. Its decoded position
      // is then resolved to the source PTS by the frame lookup.
      if (!native || (video.paused && (event?.type === "seeked" || (presented.current == null && video.currentTime === 0)))) {
        decodedPausedSeek = native && video.paused && event?.type === "seeked";
        publish(video.currentTime);
      }
    };
    video.addEventListener("seeking", seek);
    video.addEventListener("playing", resume);
    for (const event of ["loadeddata", "seeked", "timeupdate"]) video.addEventListener(event, update);
    if (native) scheduleFrame(); else animation = requestAnimationFrame(fallback);
    update();
    return () => {
      live = false;
      if (native) video.cancelVideoFrameCallback(frame); else cancelAnimationFrame(animation);
      video.removeEventListener("seeking", seek);
      video.removeEventListener("playing", resume);
      for (const event of ["loadeddata", "seeked", "timeupdate"]) video.removeEventListener(event, update);
    };
  }, [ref, source]);
  return { time, readPresentedTime: () => ref.current?.seeking ? null : presented.current };
}
