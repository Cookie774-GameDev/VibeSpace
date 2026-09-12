(() => {
  "use strict";

  const scenes = [
    {
      id: "network",
      label: "The Network",
      eyebrow: "A world that thinks with you",
      title: "Your ideas become a place.",
      body: "VibeSpace connects every tool, thought, and conversation inside one living creative system.",
      tags: ["Connected intelligence", "One creative world", "Always in flow"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-01-network.mp4",
      connector: "images/origami-scroll/work/higgsfield-test/connectors/scene-01-to-02.mp4",
      connectorPoster: "images/origami-scroll/work/higgsfield-test/connector-frames/scene-01-network-last.png",
      poster: "images/origami-scroll/source/scene-01-network.png",
      position: "50% center"
    },
    {
      id: "voice",
      label: "Jarvis Voice",
      eyebrow: "Conversation, with presence",
      title: "Speak. It understands.",
      body: "Jarvis listens with context, responds with personality, and turns natural conversation into momentum.",
      tags: ["Natural voices", "Live context", "Hands-free control"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-02-jarvis-voice.mp4",
      connector: "images/origami-scroll/work/higgsfield-test/connectors/scene-02-to-03.mp4",
      connectorPoster: "images/origami-scroll/work/higgsfield-test/connector-frames/scene-02-jarvis-voice-last.png",
      poster: "images/origami-scroll/source/scene-02-jarvis-voice.png",
      position: "58% center"
    },
    {
      id: "terminal",
      label: "Terminal",
      eyebrow: "Power without the friction",
      title: "Build at the speed of thought.",
      body: "A visual command workshop turns complex tools into a clear, responsive place to create and ship.",
      tags: ["Agentic building", "Live terminal", "Creative automation"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-03-terminal-workshop.mp4",
      connector: "images/origami-scroll/work/higgsfield-test/connectors/scene-03-to-04.mp4",
      connectorPoster: "images/origami-scroll/work/higgsfield-test/connector-frames/scene-03-terminal-workshop-last.png",
      poster: "images/origami-scroll/source/scene-03-terminal-workshop.png",
      position: "60% center"
    },
    {
      id: "actions",
      label: "Actions",
      eyebrow: "Intent becomes action",
      title: "It remembers what comes next.",
      body: "Plans, calls, reminders, and workflows move together—quietly orchestrated around your day.",
      tags: ["Smart scheduling", "Connected actions", "Proactive assistance"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-04-jarvis-actions.mp4",
      connector: "images/origami-scroll/work/higgsfield-test/connectors/scene-04-to-05.mp4",
      connectorPoster: "images/origami-scroll/work/higgsfield-test/connector-frames/scene-04-jarvis-actions-last.png",
      poster: "images/origami-scroll/source/scene-04-jarvis-actions.png",
      position: "57% center"
    },
    {
      id: "memory",
      label: "Deep Context",
      eyebrow: "Memory with meaning",
      title: "Nothing important gets lost.",
      body: "Documents, projects, and past decisions flow into a shared context that becomes more useful over time.",
      tags: ["Long-term memory", "Project context", "Knowledge graph"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-05-context-memory.mp4",
      connector: "images/origami-scroll/work/higgsfield-test/connectors/scene-05-to-outro.mp4",
      connectorPoster: "images/origami-scroll/work/higgsfield-test/connector-frames/scene-05-context-memory-last.png",
      poster: "images/origami-scroll/source/scene-05-context-memory.png",
      position: "58% center"
    },
    {
      id: "workspace",
      label: "Your Workspace",
      eyebrow: "One space, shaped around you",
      title: "Welcome to your Living OS.",
      body: "A personal world for creating, communicating, and getting things done—without losing the human feeling.",
      tags: ["Mac + Windows", "Desktop + iPhone", "Built around you"],
      video: "images/origami-scroll/work/higgsfield-test/dives/scene-05-outro-workspace.mp4",
      poster: "images/origami-scroll/source/scene-05-outro-workspace.png",
      position: "54% center",
      cta: true
    }
  ];

  const clips = scenes.flatMap((scene, sceneIndex) => {
    const dive = {
      key: `dive:${scene.id}`,
      sceneIndex,
      kind: "dive",
      video: scene.video,
      poster: scene.poster,
      label: scene.label,
      position: scene.position
    };

    if (!scene.connector) return [dive];

    return [
      dive,
      {
        key: `connector:${scene.id}`,
        sceneIndex,
        kind: "connector",
        video: scene.connector,
        poster: scene.connectorPoster,
        label: `${scene.label} passage`,
        position: "50% center"
      }
    ];
  });

  const DIVE_SHARE = 0.7;
  const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
  const smoothstep = (edge0, edge1, value) => {
    const x = clamp((value - edge0) / (edge1 - edge0));
    return x * x * (3 - 2 * x);
  };

  const chapterTrack = document.getElementById("chapter-track");
  const routeNav = document.getElementById("route-nav");
  const copy = document.getElementById("scene-copy");
  const sceneNumber = document.getElementById("scene-number");
  const sceneEyebrow = document.getElementById("scene-eyebrow");
  const sceneTitle = document.getElementById("scene-title");
  const sceneBody = document.getElementById("scene-body");
  const sceneTags = document.getElementById("scene-tags");
  const sceneCta = document.getElementById("scene-cta");
  const meterFill = document.getElementById("meter-fill");
  const meterPercent = document.getElementById("meter-percent");
  const seamVeil = document.getElementById("seam-veil");
  const scrollCue = document.getElementById("scroll-cue");

  const layers = [
    {
      video: document.getElementById("video-a"),
      poster: document.getElementById("poster-a"),
      mediaKey: ""
    },
    {
      video: document.getElementById("video-b"),
      poster: document.getElementById("poster-b"),
      mediaKey: ""
    }
  ];

  const blobs = new Map();
  const pendingBlobs = new Map();
  let activeIndex = -1;
  let ticking = false;
  let primed = false;
  let lastProgress = -1;
  let copyTimer = 0;

  function buildNavigation() {
    scenes.forEach((scene, index) => {
      const chapter = document.createElement("section");
      chapter.className = "scroll-chapter";
      chapter.id = `chapter-${scene.id}`;
      chapter.dataset.index = String(index);
      chapter.setAttribute("aria-label", `${index + 1}. ${scene.label}`);
      chapterTrack.appendChild(chapter);

      const button = document.createElement("button");
      button.className = "route-button";
      button.type = "button";
      button.dataset.index = String(index);
      button.innerHTML = `<span>${scene.label}</span>`;
      button.addEventListener("click", () => {
        window.scrollTo({ top: chapter.offsetTop, behavior: "smooth" });
      });
      routeNav.appendChild(button);
    });
  }

  async function ensureBlob(mediaKey, videoUrl) {
    if (!mediaKey || !videoUrl) return null;
    if (blobs.has(mediaKey)) return blobs.get(mediaKey);
    if (pendingBlobs.has(mediaKey)) return pendingBlobs.get(mediaKey);

    const request = fetch(videoUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Video request failed: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        blobs.set(mediaKey, url);
        pendingBlobs.delete(mediaKey);
        return url;
      })
      .catch((error) => {
        console.warn("[Origami World] Blob loading fell back to the direct URL.", error);
        pendingBlobs.delete(mediaKey);
        return videoUrl;
      });

    pendingBlobs.set(mediaKey, request);
    return request;
  }

  async function assignLayer(layerIndex, media) {
    if (!media) return;

    const layer = layers[layerIndex];
    if (layer.mediaKey === media.key) return;

    layer.mediaKey = media.key;
    layer.poster.src = media.poster;
    layer.poster.alt = `${media.label} origami world`;
    layer.poster.style.objectPosition = media.position;
    layer.poster.style.visibility = "visible";
    layer.video.style.objectPosition = media.position;

    const src = await ensureBlob(media.key, media.video);
    if (layer.mediaKey !== media.key) return;

    layer.video.src = src;
    layer.video.load();
    layer.video.addEventListener("loadeddata", () => {
      if (layer.mediaKey !== media.key) return;
      layer.poster.style.visibility = "hidden";
      lastProgress = -1;
      requestRender();
    }, { once: true });
  }

  function seek(layerIndex, progress) {
    const video = layers[layerIndex].video;
    if (!Number.isFinite(video.duration) || video.readyState < 1) return;

    const target = clamp(progress) * Math.max(0, video.duration - 0.045);
    if (!video.seeking && Math.abs(video.currentTime - target) > 0.025) {
      try {
        video.currentTime = target;
      } catch (_) {
        // The endpoint poster remains visible until the browser makes the clip seekable.
      }
    }
  }

  function setCopy(index) {
    const scene = scenes[index];
    window.clearTimeout(copyTimer);
    copy.classList.add("is-changing");

    copyTimer = window.setTimeout(() => {
      sceneNumber.textContent = `${String(index + 1).padStart(2, "0")} / ${String(scenes.length).padStart(2, "0")}`;
      sceneEyebrow.textContent = scene.eyebrow;
      sceneTitle.textContent = scene.title;
      sceneBody.textContent = scene.body;
      sceneTags.replaceChildren(...scene.tags.map((tag) => {
        const item = document.createElement("span");
        item.textContent = tag;
        return item;
      }));
      sceneCta.classList.toggle("is-visible", Boolean(scene.cta));
      copy.classList.remove("is-changing");
    }, 150);

    document.querySelectorAll(".route-button").forEach((button, buttonIndex) => {
      button.classList.toggle("is-active", buttonIndex === index);
      if (buttonIndex === index) button.setAttribute("aria-current", "step");
      else button.removeAttribute("aria-current");
    });
  }

  function readProgress() {
    const maxScroll = Math.max(1, chapterTrack.offsetHeight - window.innerHeight);
    return clamp(window.scrollY / maxScroll);
  }

  function render() {
    ticking = false;

    const progress = readProgress();
    if (Math.abs(progress - lastProgress) < 0.00002) return;
    lastProgress = progress;

    const scaled = progress * scenes.length;
    const index = Math.min(scenes.length - 1, Math.floor(scaled));
    const local = clamp(scaled - index);

    if (index !== activeIndex) {
      activeIndex = index;
      setCopy(index);
    }

    const isFinalScene = index === scenes.length - 1;
    const isConnector = !isFinalScene && local >= DIVE_SHARE;
    const clipOrdinal = index * 2 + (isConnector ? 1 : 0);
    const currentClip = clips[clipOrdinal];
    const nextClip = clips[clipOrdinal + 1] || null;
    const currentLayer = clipOrdinal % 2;
    const nextLayer = 1 - currentLayer;
    const clipProgress = isFinalScene
      ? local
      : isConnector
        ? clamp((local - DIVE_SHARE) / (1 - DIVE_SHARE))
        : clamp(local / DIVE_SHARE);
    const transition = nextClip ? smoothstep(0.92, 0.995, clipProgress) : 0;
    const veil = nextClip ? Math.sin(transition * Math.PI) * 0.72 : 0;

    assignLayer(currentLayer, currentClip);
    if (nextClip) assignLayer(nextLayer, nextClip);

    seek(currentLayer, clipProgress);
    if (nextClip) seek(nextLayer, 0);

    layers[currentLayer].video.style.opacity = String(1 - transition);
    layers[currentLayer].poster.style.opacity = String(1 - transition);
    layers[nextLayer].video.style.opacity = String(transition);
    layers[nextLayer].poster.style.opacity = String(transition);
    layers[currentLayer].video.style.transform = `scale(${1.012 + clipProgress * 0.006})`;
    layers[nextLayer].video.style.transform = `scale(${1.022 - transition * 0.01})`;

    seamVeil.style.opacity = String(veil);
    seamVeil.style.transform = `scale(${1.08 - veil * 0.08}) rotate(${(transition - 0.5) * 2.2}deg)`;
    meterFill.style.transform = `scaleX(${progress})`;
    meterPercent.textContent = `${String(Math.round(progress * 100)).padStart(2, "0")}%`;
    scrollCue.style.opacity = String(clamp(1 - progress * 18));

    const preloadClip = clips[clipOrdinal + 2];
    if (preloadClip) ensureBlob(preloadClip.key, preloadClip.video);
  }

  function requestRender() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(render);
  }

  function primeVideos() {
    if (primed) return;
    primed = true;

    layers.forEach(({ video }) => {
      const promise = video.play();
      if (promise && typeof promise.then === "function") {
        promise.then(() => video.pause()).catch(() => {});
      }
    });
  }

  function init() {
    buildNavigation();
    assignLayer(0, clips[0]);
    assignLayer(1, clips[1]);
    ensureBlob(clips[2].key, clips[2].video);

    window.addEventListener("scroll", requestRender, { passive: true });
    window.addEventListener("resize", requestRender, { passive: true });
    window.addEventListener("orientationchange", requestRender, { passive: true });
    window.addEventListener("pointerdown", primeVideos, { once: true, passive: true });
    window.addEventListener("touchstart", primeVideos, { once: true, passive: true });
    window.addEventListener("beforeunload", () => {
      blobs.forEach((url) => {
        if (url.startsWith("blob:")) URL.revokeObjectURL(url);
      });
    });

    render();
  }

  init();
})();
