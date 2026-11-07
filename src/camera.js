// Camera access with every failure mapped to something the user can act on.

export class CameraError extends Error {
  constructor(code, cause) {
    super(code);
    this.code = code; // insecure | unsupported | denied | nocam | busy | failed
    this.cause = cause;
  }
}

export function inAppBrowser() {
  const ua = navigator.userAgent || '';
  return /MicroMessenger|Weibo|QQ\/|DingTalk|Lark|Feishu|BytedanceWebview|musical_ly|TikTok|aweme|FBAN|FBAV|Instagram|Line\//i.test(ua);
}

export async function openCamera(video, cfg) {
  if (!window.isSecureContext) throw new CameraError('insecure');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new CameraError('unsupported');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: cfg.idealWidth },
        height: { ideal: cfg.idealHeight },
        frameRate: { ideal: cfg.maxFrameRate, max: cfg.maxFrameRate },
      },
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new CameraError('denied', e);
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError')
      throw new CameraError('nocam', e);
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
      throw new CameraError('busy', e);
    throw new CameraError('failed', e);
  }
  await attachStream(video, stream);
  return stream;
}

/** Dev/QA input: play a video file through the same pipeline (`?src=clip.mp4`). */
export async function openTestSource(video, url) {
  video.srcObject = null;
  video.src = url;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  await waitForDims(video);
}

async function attachStream(video, stream) {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch (e) {
    // Autoplay can be refused if the tap gesture got lost; caller shows a retry.
    stopStream(stream);
    throw new CameraError('failed', e);
  }
  await waitForDims(video);
}

function waitForDims(video) {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new CameraError('failed', new Error('no frames'))), 8000);
    video.addEventListener(
      'loadeddata',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export function stopStream(stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
}
