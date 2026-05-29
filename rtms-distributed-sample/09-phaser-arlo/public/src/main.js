const WORLD_WIDTH = 1060;
const WORLD_HEIGHT = 720;
const REJECTED_GATE_PROGRESS = 1 / 3;
const HIGH_DENSITY_THRESHOLD = 250;
const DENSE_SPRITE_THRESHOLD = 120;
const LIVE_STREAM_STALE_MS = 180 * 1000;
const TERMINAL_EXIT_ANIMATION_MS = 90 * 1000;
const COMPLETED_STORAGE_HOLD_MS = 25 * 1000;

const REGION_STYLES = {
  'amer-west': { label: 'Amer West', color: 0xe15d4f, x: 410, y: 182 },
  'amer-east': { label: 'Amer East', color: 0x4f8ee1, x: 640, y: 246 },
  europe: { label: 'Europe', color: 0x8f65cf, x: 382, y: 512 },
  'apac-hub': { label: 'APAC Hub', color: 0x2eaa78, x: 684, y: 546 },
  unknown: { label: 'Fallback', color: 0xc28a2e, x: 512, y: 362 }
};

const REGION_WORKSHOPS = {
  'amer-west': {
    k8s: { x: 292, y: 178 },
    pod: { x: 520, y: 166 },
    cache: { x: 292, y: 278 },
    logs: { x: 530, y: 284 }
  },
  'amer-east': {
    k8s: { x: 598, y: 156 },
    pod: { x: 760, y: 244 },
    cache: { x: 586, y: 334 },
    logs: { x: 762, y: 352 }
  },
  europe: {
    k8s: { x: 286, y: 472 },
    pod: { x: 510, y: 504 },
    cache: { x: 304, y: 590 },
    logs: { x: 526, y: 614 }
  },
  'apac-hub': {
    k8s: { x: 622, y: 458 },
    pod: { x: 792, y: 552 },
    cache: { x: 608, y: 636 },
    logs: { x: 806, y: 636 }
  },
  unknown: {
    k8s: { x: 608, y: 346 },
    pod: { x: 706, y: 424 },
    cache: { x: 590, y: 456 },
    logs: { x: 720, y: 506 }
  }
};

const STREAM_PALETTE = [
  '#e95f5c',
  '#4d8fdf',
  '#47b47f',
  '#bd72d9',
  '#e1a13f',
  '#37a8b2',
  '#f078a4',
  '#728245',
  '#9165d8',
  '#da7046'
];

const GRAVEYARD = {
  x: 884,
  y: 170,
  slots: [
    { x: -34, y: -8 },
    { x: -4, y: 2 },
    { x: 28, y: -4 },
    { x: -22, y: 32 },
    { x: 12, y: 34 },
    { x: 44, y: 28 }
  ]
};

const POLICE_STATION = {
  x: 150,
  y: 214,
  unsignedPen: { x: 108, y: 250 },
  duplicatePen: { x: 192, y: 250 }
};

const HOSPITAL = {
  x: 264,
  y: 222,
  bed: { x: 264, y: 252 }
};

const STAGES = [
  { id: 'webhook', label: 'Webhook received' },
  { id: 'hub', label: 'Verified at hub' },
  { id: 'dispatcher', label: 'Route selected' },
  { id: 'region', label: 'Regional spoke' },
  { id: 'launcher', label: 'Regional K8s launcher' },
  { id: 'pod', label: 'Regional pod running' },
  { id: 'cache', label: 'Regional cache update' },
  { id: 'logs', label: 'Regional logs' },
  { id: 'storage', label: 'Central S3 saved' },
  { id: 'done', label: 'Completed' }
];

const NODE_INFO = {
  webhook: {
    title: 'Zoom Webhook Gate',
    body: 'Start, stop, and interrupted RTMS events enter the sample here before any worker connects to Zoom.'
  },
  hub: {
    title: 'Centralized Hub',
    body: 'Verifies Zoom signatures, rejects stale requests, drops duplicate retries, and forwards only accepted events.'
  },
  dispatcher: {
    title: 'Route Tree',
    body: 'Reads the signaling URL hint for starts and uses saved stream routes for stop or recovery events.'
  },
  launcher: {
    title: 'Kubernetes Launcher',
    body: 'Each region has its own Kubernetes launcher. It creates one Job per RTMS stream attempt and mounts the accepted envelope as a per-Job Secret.'
  },
  pod: {
    title: 'Pod Workshop',
    body: 'Each region has its own pod workshop. The worker claims the stream lease, starts RTMSManager, receives media, and keeps only one owner active.'
  },
  cache: {
    title: 'Realtime Cache Fountain',
    body: 'Each region has its own cache fountain for active-state summaries, latency samples, webhook counts, and media counters.'
  },
  logs: {
    title: 'Log Lanterns',
    body: 'Each region has its own log lanterns. Service logs and RTMSManager logs flow toward Loki, Prometheus, and Grafana dashboards.'
  },
  storage: {
    title: 'S3 / MinIO Storehouse',
    body: 'Final manifests, audio, video, transcript, and summary artifacts are saved through the artifact storage API.'
  },
  graveyard: {
    title: 'Interrupted Stream Graveyard',
    body: 'Interrupted streams and failed reconnect attempts walk here and fade away instead of reaching centralized storage.'
  },
  police: {
    title: 'Webhook Police Station',
    body: 'Unsigned and duplicate webhook attempts stay normal until the webhook gate, then switch into prison stripes and move into jail.'
  },
  hospital: {
    title: 'Reconnect Hospital',
    body: 'Streams with temporary disconnects pause here while they reconnect. If they recover, they return to their regional route instead of being buried.'
  }
};

const ui = {
  status: document.getElementById('source-status'),
  concurrencyAlert: document.getElementById('concurrency-alert'),
  concurrencyAlertDetail: document.getElementById('concurrency-alert-detail'),
  lastRefresh: document.getElementById('last-refresh'),
  dummyButton: document.getElementById('dummy-mode'),
  liveButton: document.getElementById('live-mode'),
  addButton: document.getElementById('add-stream'),
  stressButton: document.getElementById('stress-streams'),
  clearButton: document.getElementById('clear-streams'),
  dialog: document.getElementById('dialog-box'),
  concurrent: document.getElementById('stat-concurrent'),
  pods: document.getElementById('stat-pods'),
  completed: document.getElementById('stat-completed'),
  media: document.getElementById('stat-media'),
  regions: document.getElementById('region-bars'),
  webhookStats: document.getElementById('webhook-stats'),
  latencyWebhook: document.getElementById('latency-webhook'),
  latencyRtt: document.getElementById('latency-rtt'),
  latencyRttMax: document.getElementById('latency-rtt-max'),
  streamList: document.getElementById('stream-list')
};

const appState = {
  mode: 'dummy',
  streams: [],
  webhookStats: emptyWebhookStats(),
  completed: 0,
  interrupted: 0,
  rejected: [],
  cacheUnavailable: false
};

class DummyRealtimeFeed {
  constructor() {
    this.streams = [];
    this.completed = 0;
    this.interrupted = 0;
    this.sequence = 1;
    this.rejected = [];
    this.rejectedSequence = 1;
    this.nextSpawnAt = 0;
    this.nextRejectedAt = 700;
    this.maxStreams = 8;
    this.stressMode = false;
  }

  tick(now) {
    if (now >= this.nextSpawnAt && this.streams.length < this.maxStreams) {
      this.addStream(now);
      this.nextSpawnAt = now + 1500 + Math.random() * 1600;
    }
    if (now >= this.nextRejectedAt && this.rejected.length < 8) {
      this.addRejectedWebhook(now);
      this.nextRejectedAt = now + 1200 + Math.random() * 1800;
    }

    const active = [];
    for (const stream of this.streams) {
      if (stream.reconnecting) {
        this.updateReconnectStream(stream);
        active.push(stream);
        continue;
      }

      if (stream.interrupted) {
        stream.burialProgress = Math.min(1, stream.burialProgress + 0.036);
        stream.progress = stream.burialProgress;
        stream.updatedAt = new Date().toISOString();
        if (stream.burialProgress >= 1) {
          this.interrupted += 1;
        } else {
          active.push(stream);
        }
        continue;
      }

      if (stream.completed) {
        stream.completedTicks = Number(stream.completedTicks || 0) + 1;
        stream.state.state = 'artifact_saved';
        stream.updatedAt = new Date().toISOString();
        if (stream.completedTicks < 22) active.push(stream);
        continue;
      }

      stream.progress = Math.min(1, stream.progress + stream.speed * progressSpeedMultiplier(stream.progress));
      stream.state.state = stateFromProgress(stream.progress);
      stream.metrics.audio_bytes_total += 20000 + Math.floor(Math.random() * 18000);
      stream.metrics.video_bytes_total += 42000 + Math.floor(Math.random() * 60000);
      stream.latency.signaling_ping_rtt_ms = latencyStat('signaling_ping_rtt_ms', 18 + Math.random() * 95, stream.state.regionCode);
      stream.latency.webhook_ingress_latency_ms = latencyStat('webhook_ingress_latency_ms', 40 + Math.random() * 170, stream.state.regionCode);
      stream.updatedAt = new Date().toISOString();

      if (stream.shouldInterrupt && stream.progress >= stream.interruptAt) {
        this.interruptStream(stream);
        active.push(stream);
        continue;
      }

      if (stream.shouldReconnect && stream.progress >= stream.reconnectAt) {
        this.startReconnect(stream);
        active.push(stream);
        continue;
      }

      if (stream.progress >= 1) {
        this.completed += 1;
        stream.completed = true;
        stream.completedTicks = 0;
        stream.progress = 1;
        stream.state.state = 'artifact_saved';
      }
      active.push(stream);
    }
    this.streams = active;
    this.updateRejectedWebhooks();
    return this.snapshot();
  }

  addStream(now = performance.now(), initialProgress = 0) {
    const regionKeys = ['amer-west', 'amer-east', 'europe', 'apac-hub'];
    const regionCode = regionKeys[this.sequence % regionKeys.length];
    const streamId = `dummy-rtms-${String(this.sequence).padStart(3, '0')}`;
    const startLatency = 30 + Math.random() * 120;
    const stream = {
      streamId,
      progress: initialProgress,
      speed: this.stressMode ? 0.00032 + Math.random() * 0.00024 : 0.0028 + Math.random() * 0.0011,
      shouldInterrupt: !this.stressMode && (this.sequence % 5 === 0 || Math.random() < 0.18),
      interruptAt: 0.34 + Math.random() * 0.36,
      shouldReconnect: !this.stressMode && (this.sequence % 4 === 0 || Math.random() < 0.22),
      reconnectAt: 0.38 + Math.random() * 0.24,
      reconnectWillFail: !this.stressMode && (this.sequence % 11 === 0 || Math.random() < 0.18),
      createdAt: new Date(Date.now() - Math.floor(now % 9000)).toISOString(),
      updatedAt: new Date().toISOString(),
      state: {
        state: 'accepted',
        regionCode,
        nodeId: `pod-${regionCode}-${this.sequence}`,
        routeGroup: regionCode
      },
      summary: {
        text: `Arlo ${this.sequence} is carrying an RTMS stream through ${REGION_STYLES[regionCode].label}.`
      },
      metrics: {
        audio_bytes_total: 0,
        video_bytes_total: 0
      },
      latency: {
        webhook_ingress_latency_ms: latencyStat('webhook_ingress_latency_ms', startLatency, regionCode),
        signaling_ping_rtt_ms: latencyStat('signaling_ping_rtt_ms', 24 + Math.random() * 80, regionCode)
      },
      events: [
        { type: 'webhook_accepted', at: new Date().toISOString(), regionCode }
      ]
    };
    this.sequence += 1;
    this.streams.push(stream);
    return stream;
  }

  interruptStream(stream) {
    const currentPosition = pointAlongRoute(routeForStream(stream), stream.progress);
    stream.interrupted = true;
    stream.burialProgress = 0;
    stream.state.state = 'interrupted';
    stream.burialRoute = [currentPosition, graveDestinationForStream(stream.streamId)];
    stream.events.push({
      type: 'rtms_interrupted_dummy',
      at: new Date().toISOString(),
      regionCode: stream.state.regionCode
    });
  }

  startReconnect(stream) {
    const currentPosition = pointAlongRoute(routeForStream(stream), stream.progress);
    stream.reconnecting = true;
    stream.reconnectProgress = 0;
    stream.reconnectPhase = 'to_hospital';
    stream.resumeProgress = stream.progress + 0.03;
    stream.state.state = 'reconnecting';
    stream.hospitalRoute = [currentPosition, HOSPITAL.bed];
    stream.events.push({
      type: 'rtms_temporary_disconnect_dummy',
      at: new Date().toISOString(),
      regionCode: stream.state.regionCode
    });
  }

  updateReconnectStream(stream) {
    stream.reconnectProgress = Math.min(1, stream.reconnectProgress + 0.045);
    stream.progress = stream.reconnectProgress;
    stream.updatedAt = new Date().toISOString();

    if (stream.reconnectPhase === 'to_hospital' && stream.reconnectProgress >= 1) {
      stream.reconnectPhase = 'healing';
      stream.healTicks = 0;
      stream.reconnectProgress = 0;
      stream.progress = 0;
      stream.hospitalRoute = [HOSPITAL.bed, HOSPITAL.bed];
      return;
    }

    if (stream.reconnectPhase === 'healing') {
      stream.healTicks = Number(stream.healTicks || 0) + 1;
      if (stream.healTicks > 10) {
        if (stream.reconnectWillFail) {
          this.failReconnect(stream);
          return;
        }
        stream.reconnectPhase = 'returning';
        stream.reconnectProgress = 0;
        stream.progress = 0;
        const returnPoint = pointAlongRoute(routeForStream({ ...stream, reconnecting: false }), stream.resumeProgress);
        stream.hospitalRoute = [HOSPITAL.bed, returnPoint];
      }
      return;
    }

    if (stream.reconnectPhase === 'returning' && stream.reconnectProgress >= 1) {
      stream.reconnecting = false;
      stream.reconnectProgress = 0;
      stream.progress = stream.resumeProgress;
      stream.state.state = 'reconnected';
      stream.shouldReconnect = false;
      stream.events.push({
        type: 'rtms_reconnected_dummy',
        at: new Date().toISOString(),
        regionCode: stream.state.regionCode
      });
    }
  }

  failReconnect(stream) {
    const currentPosition = pointAlongRoute(stream.hospitalRoute || [HOSPITAL.bed, HOSPITAL.bed], stream.reconnectProgress || 0);
    stream.reconnecting = false;
    stream.reconnectFailed = true;
    stream.interrupted = true;
    stream.burialProgress = 0;
    stream.progress = 0;
    stream.state.state = 'reconnect_failed';
    stream.burialRoute = [currentPosition, graveDestinationForStream(stream.streamId)];
    stream.events.push({
      type: 'rtms_reconnect_failed_dummy',
      at: new Date().toISOString(),
      regionCode: stream.state.regionCode
    });
  }

  addRejectedWebhook(now = performance.now()) {
    const type = this.rejectedSequence % 2 === 0 ? 'duplicate' : 'unsigned';
    const id = `rejected-${type}-${String(this.rejectedSequence).padStart(3, '0')}`;
    this.rejectedSequence += 1;
    this.rejected.push({
      id,
      type,
      progress: 0,
      speed: 0.018 + Math.random() * 0.012,
      createdAt: new Date(Date.now() - Math.floor(now % 2000)).toISOString(),
      holdTicks: 0
    });
  }

  updateRejectedWebhooks() {
    const active = [];
    for (const rejected of this.rejected) {
      rejected.progress = Math.min(1, rejected.progress + rejected.speed);
      if (rejected.progress >= 1) rejected.holdTicks = Number(rejected.holdTicks || 0) + 1;
      if (Number(rejected.holdTicks || 0) < 28) active.push(rejected);
    }
    this.rejected = active;
  }

  clear() {
    this.streams = [];
    this.completed = 0;
    this.interrupted = 0;
    this.rejected = [];
    this.rejectedSequence = 1;
    this.nextSpawnAt = 0;
    this.nextRejectedAt = 700;
    this.maxStreams = 8;
    this.stressMode = false;
  }

  seedStress(count = 150) {
    this.clear();
    this.maxStreams = count;
    this.stressMode = true;
    this.nextSpawnAt = Number.POSITIVE_INFINITY;
    this.nextRejectedAt = Number.POSITIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      this.addStream(performance.now(), 0.05 + Math.random() * 0.74);
    }
  }

  snapshot() {
    return {
      streams: this.streams.map((stream) => ({ ...stream })),
      completed: this.completed,
      interrupted: this.interrupted,
      rejected: this.rejected.map((event) => ({ ...event })),
      webhookStats: dummyWebhookStats(this.streams.length, this.completed, this.rejected)
    };
  }
}

class ArloPixiApp {
  constructor() {
    this.app = new PIXI.Application({
      width: WORLD_WIDTH,
      height: WORLD_HEIGHT,
      backgroundColor: 0x82c98f,
      antialias: false,
      resolution: 1,
      autoDensity: false,
      powerPreference: 'high-performance'
    });
    this.app.stage.sortableChildren = true;
    this.app.view.style.width = '100%';
    this.app.view.style.height = '100%';
    this.app.view.style.display = 'block';
    this.stageElement = document.getElementById('phaser-stage');
    this.stageElement.innerHTML = '';
    this.stageElement.appendChild(this.app.view);

    this.feed = new DummyRealtimeFeed();
    this.actors = new Map();
    this.rejectedActors = new Map();
    this.textures = new Map();
    this.highDensityMode = false;
    this.denseSpriteMode = false;
    this.lastDummySync = 0;
    this.frameCount = 0;

    this.worldLayer = new PIXI.Container();
    this.actorLayer = new PIXI.Container();
    this.bulkLayer = new PIXI.Graphics();
    this.worldLayer.sortableChildren = true;
    this.actorLayer.sortableChildren = true;
    this.bulkLayer.zIndex = 42;
    this.bulkLayer.visible = false;
    this.app.stage.addChild(this.worldLayer, this.actorLayer, this.bulkLayer);
  }

  async start() {
    const image = await loadImage('/assets/arlo-sprite.jpg');
    this.buildTextures(image);
    this.drawWorld();
    this.seedInitialStreams();
    this.bindUi();
    this.app.ticker.add(() => this.update(this.app.ticker.lastTime));
    setMode('dummy');
  }

  buildTextures(image) {
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = image.width;
    sourceCanvas.height = image.height;
    const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sourceContext.drawImage(image, 0, 0);
    const sourceData = sourceContext.getImageData(0, 0, image.width, image.height);

    STREAM_PALETTE.forEach((color, paletteIndex) => {
      const rgb = hexToRgb(color);
      for (let frameIndex = 0; frameIndex < 25; frameIndex += 1) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const context = canvas.getContext('2d');
        const frame = context.createImageData(64, 64);
        const col = frameIndex % 5;
        const row = Math.floor(frameIndex / 5);
        const cell = image.width / 5;
        const cropX = col * cell;
        const cropY = row * cell;

        for (let y = 0; y < 64; y += 1) {
          for (let x = 0; x < 64; x += 1) {
            const sx = Math.floor(cropX + (x / 64) * cell);
            const sy = Math.floor(cropY + (y / 64) * cell);
            const sourceOffset = (sy * image.width + sx) * 4;
            const targetOffset = (y * 64 + x) * 4;
            const r = sourceData.data[sourceOffset];
            const g = sourceData.data[sourceOffset + 1];
            const b = sourceData.data[sourceOffset + 2];
            const lum = (r + g + b) / 3;

            if (lum < 120) {
              frame.data[targetOffset] = rgb.r;
              frame.data[targetOffset + 1] = rgb.g;
              frame.data[targetOffset + 2] = rgb.b;
              frame.data[targetOffset + 3] = 255;
            } else if (lum > 235 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && nearbyDarkPixels(sourceData, image.width, image.height, sx, sy) >= 9) {
              frame.data[targetOffset] = 255;
              frame.data[targetOffset + 1] = 255;
              frame.data[targetOffset + 2] = 238;
              frame.data[targetOffset + 3] = 255;
            } else {
              frame.data[targetOffset + 3] = 0;
            }
          }
        }

        context.putImageData(frame, 0, 0);
        this.textures.set(textureKey(paletteIndex, frameIndex), PIXI.Texture.from(canvas));
      }
      this.textures.set(deadTextureKey(paletteIndex), PIXI.Texture.from(createDeadArloCanvas(rgb)));
      this.textures.set(recoveringTextureKey(paletteIndex), PIXI.Texture.from(createRecoveringArloCanvas(rgb)));
    });
    this.textures.set(prisonTextureKey(), PIXI.Texture.from(createPrisonArloCanvas()));
  }

  seedInitialStreams() {
    this.feed.addStream(performance.now(), 0.1);
    this.feed.addStream(performance.now(), 0.45);
    this.feed.addStream(performance.now(), 0.68);
    const interrupted = this.feed.addStream(performance.now(), 0.52);
    this.feed.interruptStream(interrupted);
    const recovering = this.feed.addStream(performance.now(), 0.46);
    recovering.shouldInterrupt = false;
    this.feed.startReconnect(recovering);
    this.feed.addRejectedWebhook(performance.now());
    this.feed.addRejectedWebhook(performance.now());
    if (this.feed.rejected[0]) this.feed.rejected[0].progress = 0.22;
    if (this.feed.rejected[1]) this.feed.rejected[1].progress = 0.72;

    const stressCount = stressCountFromUrl();
    if (stressCount > 0) {
      this.feed.seedStress(stressCount);
      applyDummySnapshot(this.feed.snapshot());
      ui.status.textContent = `dummy stress feed: ${stressCount} concurrent`;
    }
  }

  bindUi() {
    ui.dummyButton.addEventListener('click', () => setMode('dummy'));
    ui.liveButton.addEventListener('click', () => setMode('live'));
    ui.addButton.addEventListener('click', () => {
      if (appState.mode !== 'dummy') setMode('dummy');
      this.feed.addStream(performance.now());
    });
    ui.stressButton.addEventListener('click', () => {
      if (appState.mode !== 'dummy') setMode('dummy');
      this.feed.seedStress(150);
      applyDummySnapshot(this.feed.snapshot());
      ui.status.textContent = 'dummy stress feed: 150 concurrent';
      renderStats();
    });
    ui.clearButton.addEventListener('click', () => {
      this.feed.clear();
      appState.streams = [];
      appState.completed = 0;
      appState.interrupted = 0;
      appState.rejected = [];
      appState.webhookStats = emptyWebhookStats();
      this.clearActors();
      this.clearRejectedActors();
      this.bulkLayer.clear();
      renderStats();
    });

    setInterval(() => {
      if (appState.mode === 'live') fetchLiveCache();
    }, 2500);
  }

  update(time) {
    this.frameCount += 1;
    if (appState.mode === 'dummy' && time - this.lastDummySync > 180) {
      applyDummySnapshot(this.feed.tick(time));
      this.lastDummySync = time;
      renderStats();
    }

    const nextHighDensityMode = appState.streams.length + appState.rejected.length > HIGH_DENSITY_THRESHOLD;
    if (nextHighDensityMode !== this.highDensityMode) {
      this.setHighDensityMode(nextHighDensityMode);
    }

    if (this.highDensityMode) {
      if (this.frameCount % 3 === 0) this.drawBulkActors(time);
      return;
    }

    this.denseSpriteMode = appState.streams.length + appState.rejected.length > DENSE_SPRITE_THRESHOLD;
    this.bulkLayer.clear();
    this.bulkLayer.visible = false;
    this.syncActors(appState.streams);
    this.syncRejectedActors(appState.rejected);
    for (const actor of this.actors.values()) actor.update(time, this.denseSpriteMode, this.frameCount);
    for (const actor of this.rejectedActors.values()) actor.update(time, this.denseSpriteMode, this.frameCount);
  }

  setHighDensityMode(enabled) {
    this.highDensityMode = enabled;
    if (!enabled) {
      this.bulkLayer.clear();
      this.bulkLayer.visible = false;
      return;
    }
    this.clearActors();
    this.clearRejectedActors();
  }

  syncActors(streams) {
    const activeIds = new Set(streams.map((stream) => stream.streamId));
    for (const stream of streams) {
      let actor = this.actors.get(stream.streamId);
      if (!actor) {
        actor = new SpriteArloActor(this, stream);
        this.actors.set(stream.streamId, actor);
      }
      actor.setStream(stream);
    }
    for (const [streamId, actor] of this.actors.entries()) {
      if (!activeIds.has(streamId)) {
        actor.despawn();
        this.actors.delete(streamId);
      }
    }
  }

  syncRejectedActors(events) {
    const activeIds = new Set(events.map((event) => event.id));
    for (const event of events) {
      let actor = this.rejectedActors.get(event.id);
      if (!actor) {
        actor = new RejectedArloActor(this, event);
        this.rejectedActors.set(event.id, actor);
      }
      actor.setEvent(event);
    }
    for (const [eventId, actor] of this.rejectedActors.entries()) {
      if (!activeIds.has(eventId)) {
        actor.despawn();
        this.rejectedActors.delete(eventId);
      }
    }
  }

  drawBulkActors(time) {
    this.bulkLayer.clear();
    this.bulkLayer.visible = true;
    for (const stream of appState.streams) {
      const point = pointAlongRoute(routeForStream(stream), progressForStream(stream));
      const color = STREAM_PALETTE[hashString(stream.streamId) % STREAM_PALETTE.length];
      const mode = stream.interrupted ? 'dead' : (stream.reconnecting ? 'recovering' : 'walking');
      const alpha = stream.completed ? Math.max(0.15, 1 - Number(stream.completedTicks || 0) / 22) : 1;
      drawBulkArlo(this.bulkLayer, point.x, point.y, color, mode, alpha, time);
    }
    for (const event of appState.rejected) {
      const progress = Number(event.progress || 0);
      const point = pointAlongRoute(routeForRejected(event), progress);
      const color = STREAM_PALETTE[hashString(event.id) % STREAM_PALETTE.length];
      const alpha = progress >= 1 ? Math.max(0.15, 1 - Number(event.holdTicks || 0) / 28) : 1;
      drawBulkArlo(this.bulkLayer, point.x, point.y, color, progress >= REJECTED_GATE_PROGRESS ? 'prison' : 'walking', alpha, time);
    }
  }

  clearActors() {
    for (const actor of this.actors.values()) actor.destroy();
    this.actors.clear();
  }

  clearRejectedActors() {
    for (const actor of this.rejectedActors.values()) actor.destroy();
    this.rejectedActors.clear();
  }

  drawWorld() {
    const g = new PIXI.Graphics();
    this.worldLayer.addChild(g);
    g.beginFill(0x82c98f).drawRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).endFill();
    drawTileTexture(g);
    drawWater(g);
    drawTownFence(g);
    drawMainPath(g);
    drawSidePaths(g);
    drawRegionalFlowPaths(g);
    drawStoneEdges(g);
    drawFences(g);
    drawGraveyard(this);
    drawPoliceStation(this);
    drawHospital(this);
    drawShrubs(g);
    drawFlowers(g);
    drawSignPosts(g);

    drawBuilding(this, 'webhook', 78, 342, 0xc65d4d, 'Webhook\nGate', 'gate');
    drawBuilding(this, 'hub', 202, 342, 0x4e83c4, 'Hub\nHouse', 'hub');
    drawBuilding(this, 'dispatcher', 334, 342, 0x7c9b4e, 'Route\nTree', 'tree');
    drawBuilding(this, 'storage', 956, 384, 0xc98935, 'Central S3\nExit', 'storage');

    for (const [regionId, region] of Object.entries(REGION_STYLES)) {
      if (regionId === 'unknown') continue;
      drawRegionLodge(this, regionId, region);
      drawRegionalWorkshops(this, regionId);
    }
  }
}

class SpriteArloActor {
  constructor(app, stream) {
    this.app = app;
    this.stream = stream;
    this.streamId = stream.streamId;
    this.paletteIndex = hashString(stream.streamId) % STREAM_PALETTE.length;
    this.progress = 0;
    this.route = routeForStream(stream);
    this.wasInterrupted = Boolean(stream.interrupted);
    this.wasReconnecting = Boolean(stream.reconnecting);
    this.reconnectPhase = stream.reconnectPhase || null;
    this.sprite = new PIXI.Sprite(app.textures.get(initialArloTexture(this.paletteIndex, stream)));
    this.sprite.anchor.set(0.5, 0.78);
    this.sprite.scale.set(1.08);
    this.sprite.zIndex = 30 + this.paletteIndex;
    this.sprite.interactive = true;
    this.sprite.cursor = 'pointer';
    this.sprite.on('pointerdown', () => showStreamDialog(stream.streamId));
    app.actorLayer.addChild(this.sprite);
  }

  setStream(stream) {
    const becameInterrupted = Boolean(stream.interrupted) && !this.wasInterrupted;
    if (becameInterrupted) {
      stream.burialRoute = [
        { x: this.sprite.x, y: this.sprite.y },
        graveDestinationForStream(stream.streamId)
      ];
      stream.burialProgress = 0;
      this.progress = 0;
      this.wasInterrupted = true;
      this.wasReconnecting = false;
    }

    const becameReconnecting = Boolean(stream.reconnecting) && !this.wasReconnecting && !stream.interrupted;
    if (becameReconnecting) {
      stream.hospitalRoute = [
        { x: this.sprite.x, y: this.sprite.y },
        HOSPITAL.bed
      ];
      stream.reconnectProgress = 0;
      this.progress = 0;
      this.wasReconnecting = true;
      this.reconnectPhase = stream.reconnectPhase || 'to_hospital';
    } else if (stream.reconnecting && this.wasReconnecting) {
      const nextPhase = stream.reconnectPhase || 'to_hospital';
      if (nextPhase === this.reconnectPhase && Array.isArray(this.route)) {
        stream.hospitalRoute = this.route;
      } else {
        this.reconnectPhase = nextPhase;
        this.progress = 0;
      }
    }

    if (!stream.reconnecting && this.wasReconnecting) {
      this.wasReconnecting = false;
      this.reconnectPhase = null;
      this.progress = progressForStream(stream);
    }

    this.stream = stream;
    this.route = routeForStream(stream);
  }

  update(time, denseMode = false, frameCount = 0) {
    if (denseMode && frameCount % 2 === this.paletteIndex % 2) return;
    const targetProgress = progressForStream(this.stream);
    if (!this.stream.interrupted && !this.stream.reconnecting && targetProgress > this.progress) {
      const baseStep = this.stream.completed ? 0.0045 : 0.0035;
      this.progress = Math.min(targetProgress, this.progress + baseStep * progressSpeedMultiplier(this.progress));
    } else {
      const easing = this.stream.interrupted ? 0.2 : (this.stream.reconnecting ? 0.24 : 0.08);
      this.progress += (targetProgress - this.progress) * easing;
    }
    const position = pointAlongRoute(this.route, this.progress);
    const previousX = this.sprite.x;
    const verticalBob = denseMode || this.stream.completed || this.stream.interrupted ? 0 : Math.sin(time / (this.stream.reconnecting ? 120 : 190) + this.paletteIndex) * (this.stream.reconnecting ? 1 : 2);
    const scale = denseMode ? 0.68 : 1.08;

    this.sprite.position.set(position.x, position.y + verticalBob);
    this.sprite.scale.set(scale * (position.x < previousX ? -1 : 1), scale);
    this.sprite.interactive = !denseMode;

    if (this.stream.interrupted) {
      this.setTexture(deadTextureKey(this.paletteIndex));
    } else if (this.stream.reconnecting) {
      this.setTexture(denseMode ? textureKey(this.paletteIndex, 7) : recoveringTextureKey(this.paletteIndex));
    } else if (denseMode) {
      this.setTexture(textureKey(this.paletteIndex, 7));
    } else {
      const stageIndex = Math.min(STAGES.length - 1, Math.floor(this.progress * (STAGES.length - 1)));
      const frameBase = stageIndex >= 8 ? 20 : 5;
      const frame = frameBase + (Math.floor(time / 150 + this.paletteIndex) % 5);
      this.setTexture(textureKey(this.paletteIndex, frame));
    }
  }

  setTexture(key) {
    const texture = this.app.textures.get(key);
    if (texture && this.sprite.texture !== texture) this.sprite.texture = texture;
  }

  despawn() {
    const startAlpha = this.sprite.alpha;
    let ticks = 0;
    const fade = () => {
      ticks += 1;
      this.sprite.alpha = startAlpha * Math.max(0, 1 - ticks / 18);
      this.sprite.y -= 1;
      if (ticks >= 18) {
        this.app.app.ticker.remove(fade);
        this.destroy();
      }
    };
    this.app.app.ticker.add(fade);
  }

  destroy() {
    this.sprite.destroy();
  }
}

class RejectedArloActor {
  constructor(app, event) {
    this.app = app;
    this.event = event;
    this.id = event.id;
    this.route = routeForRejected(event);
    this.progress = 0;
    this.paletteIndex = hashString(event.id) % STREAM_PALETTE.length;
    this.sprite = new PIXI.Sprite(app.textures.get(textureKey(this.paletteIndex, 5)));
    this.sprite.anchor.set(0.5, 0.78);
    this.sprite.scale.set(0.92);
    this.sprite.zIndex = 24 + this.paletteIndex;
    this.sprite.interactive = true;
    this.sprite.cursor = 'pointer';
    this.sprite.on('pointerdown', () => showNodeDialog('police'));
    app.actorLayer.addChild(this.sprite);
  }

  setEvent(event) {
    this.event = event;
    this.route = routeForRejected(event);
  }

  update(time, denseMode = false, frameCount = 0) {
    if (denseMode && frameCount % 2 === this.paletteIndex % 2) return;
    const targetProgress = Number(this.event.progress || 0);
    this.progress += (targetProgress - this.progress) * 0.18;
    const point = pointAlongRoute(this.route, this.progress);
    const previousX = this.sprite.x;
    const bob = denseMode || this.progress >= 1 ? 0 : Math.sin(time / 180 + this.paletteIndex) * 1.5;
    const frame = denseMode ? 7 : 5 + (Math.floor(time / 165 + this.paletteIndex) % 5);
    const scale = denseMode ? 0.62 : 0.92;
    this.setTexture(this.progress >= REJECTED_GATE_PROGRESS ? prisonTextureKey() : textureKey(this.paletteIndex, frame));
    this.sprite.position.set(point.x, point.y + bob);
    this.sprite.scale.set(scale * (point.x < previousX ? -1 : 1), scale);
    this.sprite.interactive = !denseMode;
  }

  setTexture(key) {
    const texture = this.app.textures.get(key);
    if (texture && this.sprite.texture !== texture) this.sprite.texture = texture;
  }

  despawn() {
    const startAlpha = this.sprite.alpha;
    let ticks = 0;
    const fade = () => {
      ticks += 1;
      this.sprite.alpha = startAlpha * Math.max(0, 1 - ticks / 14);
      if (ticks >= 14) {
        this.app.app.ticker.remove(fade);
        this.destroy();
      }
    };
    this.app.app.ticker.add(fade);
  }

  destroy() {
    this.sprite.destroy();
  }
}

const arloApp = new ArloPixiApp();
arloApp.start().catch((error) => {
  ui.status.textContent = `pixi renderer error: ${error.message}`;
  throw error;
});

function addText(app, x, y, value, options = {}) {
  const text = new PIXI.Text(value, {
    fontFamily: 'monospace',
    fontSize: options.fontSize || 12,
    fill: options.fill || 0x26312c,
    align: options.align || 'center',
    lineHeight: options.lineHeight || 13
  });
  text.anchor.set(options.anchorX ?? 0.5, options.anchorY ?? 0);
  text.position.set(x, y);
  text.zIndex = options.zIndex || 14;
  app.worldLayer.addChild(text);
  return text;
}

function addZone(app, x, y, width, height, nodeId) {
  const zone = new PIXI.Graphics();
  zone.beginFill(0x000000, 0.001).drawRect(-width / 2, -height / 2, width, height).endFill();
  zone.position.set(x, y);
  zone.zIndex = 50;
  zone.interactive = true;
  zone.cursor = 'pointer';
  zone.on('pointerdown', () => showNodeDialog(nodeId));
  app.worldLayer.addChild(zone);
}

function drawBuilding(app, nodeId, x, y, color, label, kind) {
  const g = new PIXI.Graphics();
  g.zIndex = 5;
  app.worldLayer.addChild(g);
  fillRect(g, x - 40, y + 56, 88, 12, 0x4b3e2a, 0.18);

  if (kind === 'tree') {
    fillRect(g, x - 9, y + 2, 18, 62, 0x6a4b2c);
    fillRect(g, x - 39, y - 22, 78, 32, 0x365f39);
    fillRect(g, x - 30, y - 38, 60, 22, 0x365f39);
    fillRect(g, x - 44, y - 10, 88, 34, 0x618a3d);
    fillRect(g, x - 20, y + 4, 7, 7, 0xf2d56b);
    fillRect(g, x + 18, y + 10, 6, 6, 0xf2d56b);
  } else {
    triangle(g, x - 52, y + 9, x, y - 39, x + 52, y + 9, 0x3f2e1b);
    triangle(g, x - 46, y + 8, x, y - 34, x + 46, y + 8, 0x5f4a31);
    fillRect(g, x - 36, y + 8, 72, 56, color);
    fillRect(g, x - 30, y + 14, 60, 6, 0xffffff, 0.18);
    fillRect(g, x - 10, y + 30, 20, 34, 0xfff1bd);
    fillRect(g, x - 27, y + 22, 15, 15, 0x3f4d40);
    fillRect(g, x + 12, y + 22, 15, 15, 0x3f4d40);
    fillRect(g, x - 23, y + 26, 7, 7, 0xf6d47a);
    fillRect(g, x + 16, y + 26, 7, 7, 0xf6d47a);
  }

  addText(app, x, y + 76, label, { fontSize: 13, lineHeight: 14 });
  addZone(app, x, y + 22, 108, 112, nodeId);
}

function drawRegionLodge(app, regionId, region) {
  const g = new PIXI.Graphics();
  g.zIndex = 6;
  app.worldLayer.addChild(g);
  fillRect(g, region.x - 48, region.y + 54, 96, 12, 0x4b3e2a, 0.16);
  triangle(g, region.x - 54, region.y + 3, region.x, region.y - 39, region.x + 54, region.y + 3, 0x3f2e1b);
  triangle(g, region.x - 48, region.y + 2, region.x, region.y - 34, region.x + 48, region.y + 2, 0x5b4a32);
  fillRect(g, region.x - 38, region.y + 2, 76, 54, region.color);
  fillRect(g, region.x - 31, region.y + 9, 62, 6, 0xffffff, 0.18);
  fillRect(g, region.x - 12, region.y + 26, 24, 30, 0xfff1bd);
  fillRect(g, region.x - 30, region.y + 17, 13, 13, 0x2d3b34);
  fillRect(g, region.x + 17, region.y + 17, 13, 13, 0x2d3b34);
  addText(app, region.x, region.y + 66, region.label, { fontSize: 12 });
  addZone(app, region.x, region.y + 22, 112, 104, `region:${regionId}`);
}

function drawRegionalWorkshops(app, regionId) {
  const layout = REGION_WORKSHOPS[regionId];
  const region = REGION_STYLES[regionId];
  if (!layout || !region) return;
  drawMiniBox(app, layout.k8s.x, layout.k8s.y, region.color, 'K8s', `region:${regionId}:k8s`, 0x2c3342);
  drawMiniBox(app, layout.pod.x, layout.pod.y, region.color, 'Pod', `region:${regionId}:pod`, 0x9f6f43);
  drawMiniBox(app, layout.cache.x, layout.cache.y, 0x5cc5d8, 'Cache', `region:${regionId}:cache`, 0x285a68);
  drawMiniBox(app, layout.logs.x, layout.logs.y, 0xf6d47a, 'Logs', `region:${regionId}:logs`, 0x4b3852);
}

function drawMiniBox(app, x, y, color, label, nodeId, shellColor) {
  const g = new PIXI.Graphics();
  g.zIndex = 7;
  app.worldLayer.addChild(g);
  fillRect(g, x - 32, y + 28, 64, 9, 0x2b402f, 0.22);
  fillRect(g, x - 28, y - 24, 56, 52, shellColor);
  fillRect(g, x - 20, y - 15, 40, 34, color);
  fillRect(g, x - 8, y + 7, 16, 21, 0xfff1bd);
  addText(app, x, y + 38, label, { fontSize: 10 });
  addZone(app, x, y, 70, 76, nodeId);
}

function drawPoliceStation(app) {
  const g = new PIXI.Graphics();
  g.zIndex = 6;
  app.worldLayer.addChild(g);
  const { x, y } = POLICE_STATION;
  triangle(g, x - 44, y - 10, x, y - 45, x + 44, y - 10, 0x253247);
  fillRect(g, x - 38, y - 10, 76, 62, 0xc9d6e2);
  fillRect(g, x - 31, y - 2, 62, 8, 0xf6f0cc);
  fillRect(g, x - 22, y + 15, 14, 18, 0x45607f);
  fillRect(g, x + 8, y + 15, 14, 18, 0x45607f);
  fillRect(g, x - 9, y + 31, 18, 21, 0x31445d);
  fillRect(g, x - 18, y - 24, 36, 14, 0xe5b44c);
  drawJailPen(g, POLICE_STATION.unsignedPen.x, POLICE_STATION.unsignedPen.y, 0xb84c53);
  drawJailPen(g, POLICE_STATION.duplicatePen.x, POLICE_STATION.duplicatePen.y, 0xd08b38);
  addText(app, x, y + 72, 'Webhook\nPolice', { fontSize: 11, lineHeight: 12 });
  addText(app, POLICE_STATION.unsignedPen.x, POLICE_STATION.unsignedPen.y + 32, 'Unsigned', { fontSize: 9 });
  addText(app, POLICE_STATION.duplicatePen.x, POLICE_STATION.duplicatePen.y + 32, 'Dupe', { fontSize: 9 });
  addZone(app, x, y + 20, 174, 130, 'police');
}

function drawJailPen(g, x, y, accent) {
  fillRect(g, x - 25, y + 23, 52, 8, 0x2b402f, 0.18);
  fillRect(g, x - 24, y - 18, 48, 43, 0x364a5c);
  fillRect(g, x - 19, y - 13, 38, 33, 0xe6edf1);
  fillRect(g, x - 22, y - 18, 44, 6, accent);
  for (let barX = x - 16; barX <= x + 16; barX += 8) fillRect(g, barX, y - 12, 3, 32, 0x2d3a48);
  fillRect(g, x - 18, y, 36, 3, 0x2d3a48);
}

function drawHospital(app) {
  const g = new PIXI.Graphics();
  g.zIndex = 6;
  app.worldLayer.addChild(g);
  const { x, y } = HOSPITAL;
  triangle(g, x - 48, y - 8, x, y - 41, x + 48, y - 8, 0x9c4f4f);
  fillRect(g, x - 40, y - 8, 80, 60, 0xf5f1dd);
  fillRect(g, x - 30, y + 17, 17, 18, 0x8ac4d8);
  fillRect(g, x + 13, y + 17, 17, 18, 0x8ac4d8);
  fillRect(g, x - 6, y + 14, 12, 32, 0xd94848);
  fillRect(g, x - 18, y + 24, 36, 12, 0xd94848);
  addText(app, x, y + 72, 'Reconnect\nHospital', { fontSize: 11, lineHeight: 12 });
  addZone(app, x, y + 20, 112, 124, 'hospital');
}

function drawGraveyard(app) {
  const g = new PIXI.Graphics();
  g.zIndex = 4;
  app.worldLayer.addChild(g);
  const { x, y } = GRAVEYARD;
  fillRect(g, x - 74, y - 58, 154, 112, 0x52715a);
  fillRect(g, x - 66, y - 50, 138, 96, 0x425f4a);
  fillRect(g, x - 76, y - 60, 160, 8, 0x314235);
  fillRect(g, x - 76, y + 52, 160, 8, 0x314235);
  for (const slot of GRAVEYARD.slots) drawStaticGrave(g, x + slot.x, y + slot.y);
  addText(app, x, y + 66, 'Interrupted\nGraveyard', { fontSize: 12, lineHeight: 13 });
  addZone(app, x, y, 168, 132, 'graveyard');
}

function drawStaticGrave(g, x, y) {
  fillRect(g, x - 12, y + 18, 28, 6, 0x2d372f, 0.28);
  fillRect(g, x - 9, y - 8, 20, 28, 0x596468);
  fillRect(g, x - 5, y - 14, 12, 8, 0x596468);
  fillRect(g, x - 5, y - 4, 12, 3, 0x9fa9aa);
  fillRect(g, x - 2, y - 10, 5, 11, 0x9fa9aa);
}

function drawTileTexture(g) {
  for (let y = 0; y < WORLD_HEIGHT; y += 32) {
    for (let x = 0; x < WORLD_WIDTH; x += 32) {
      if ((x / 32 + y / 32) % 2 === 0) fillRect(g, x, y, 32, 32, 0x8fd09c, 0.18);
    }
  }
}

function drawWater(g) {
  pixelPond(g, 24, 42, 184, 72);
  pixelPond(g, 838, 42, 188, 76);
  for (const [x, y] of [[56, 64], [106, 82], [154, 58], [870, 74], [934, 58], [982, 86]]) {
    fillRect(g, x, y, 28, 4, 0xbfeaf0, 0.9);
    fillRect(g, x + 8, y + 8, 20, 4, 0xbfeaf0, 0.9);
  }
}

function pixelPond(g, x, y, width, height) {
  fillRect(g, x + 12, y - 4, width - 24, 4, 0x4e9daf);
  fillRect(g, x + 4, y + 4, width - 8, height - 8, 0x4e9daf);
  fillRect(g, x + 16, y + 4, width - 32, height - 8, 0x7cc6d5);
  fillRect(g, x + 8, y + 16, width - 16, height - 32, 0x7cc6d5);
}

function drawTownFence(g) {
  const leftX = 42;
  const rightX = 998;
  const topY = 122;
  const bottomY = 640;
  drawFence(g, leftX, topY, rightX - leftX, 'horizontal');
  drawFence(g, leftX, bottomY, rightX - leftX, 'horizontal');
  drawFence(g, leftX, topY + 24, 174, 'vertical');
  drawFence(g, leftX, 446, bottomY - 446, 'vertical');
  drawFence(g, rightX - 24, topY + 24, 210, 'vertical');
  drawFence(g, rightX - 24, 472, bottomY - 472, 'vertical');
  drawTownGate(g, leftX, 382, 'entrance');
  drawTownGate(g, rightX, 402, 'exit');
}

function drawTownGate(g, x, y, side) {
  const direction = side === 'entrance' ? 1 : -1;
  const postX = side === 'entrance' ? x + 8 : x - 34;
  const signX = side === 'entrance' ? x + 20 : x - 78;
  fillRect(g, postX, y - 55, 14, 112, 0x4f3521);
  fillRect(g, postX + direction * 44, y - 55, 14, 112, 0x4f3521);
  fillRect(g, Math.min(postX, postX + direction * 44), y - 58, 58, 12, 0x5f4327);
  fillRounded(g, signX, y - 80, 62, 25, 4, 0xe0aa58);
}

function drawMainPath(g) {
  drawPath(g, [
    { x: 0, y: 382 },
    { x: 78, y: 382 },
    { x: 334, y: 382 },
    { x: 516, y: 360 },
    { x: 674, y: 380 },
    { x: 820, y: 360 },
    { x: 954, y: 402 },
    { x: WORLD_WIDTH, y: 402 }
  ], 25, 0xd7bf7c);
  drawPath(g, [
    { x: 0, y: 382 },
    { x: 78, y: 382 },
    { x: 334, y: 382 },
    { x: 516, y: 360 },
    { x: 674, y: 380 },
    { x: 820, y: 360 },
    { x: 954, y: 402 },
    { x: WORLD_WIDTH, y: 402 }
  ], 10, 0xf1dfa5);
}

function drawSidePaths(g) {
  drawThinPath(g, [{ x: 78, y: 382 }, { x: 88, y: 300 }, { x: POLICE_STATION.x, y: POLICE_STATION.y + 28 }]);
  drawThinPath(g, [{ x: 334, y: 360 }, { x: 304, y: 296 }, { x: HOSPITAL.x, y: HOSPITAL.y + 30 }]);
}

function drawRegionalFlowPaths(g) {
  for (const [regionId, region] of Object.entries(REGION_STYLES)) {
    if (regionId === 'unknown') continue;
    const workshops = REGION_WORKSHOPS[regionId];
    drawThinPath(g, [
      { x: region.x, y: region.y + 24 },
      workshops.k8s,
      workshops.pod,
      workshops.cache,
      workshops.logs,
      { x: 956, y: 402 }
    ]);
  }
}

function drawThinPath(g, points) {
  drawPath(g, points, 13, 0xc5ad70);
  drawPath(g, points, 5, 0xf0dc9e);
}

function drawPath(g, points, width, color) {
  g.lineStyle(width, color, 1);
  g.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) g.lineTo(point.x, point.y);
}

function drawStoneEdges(g) {
  const stones = [
    [96, 410], [132, 416], [168, 404], [252, 412], [298, 408], [392, 398],
    [468, 382], [548, 392], [612, 402], [720, 394], [768, 374], [858, 380],
    [916, 404], [236, 352], [322, 354], [438, 338], [520, 340], [626, 354],
    [742, 342], [842, 342]
  ];
  for (const [x, y] of stones) {
    fillRect(g, x, y, 9, 5, 0xa99873);
    fillRect(g, x + 1, y, 6, 2, 0xf4e8bf);
  }
}

function drawFences(g) {
  drawFence(g, 42, 476, 172, 'horizontal');
  drawFence(g, 724, 260, 162, 'horizontal');
  drawFence(g, 892, 494, 108, 'horizontal');
  drawFence(g, 260, 456, 106, 'vertical');
  drawFence(g, 700, 500, 76, 'vertical');
}

function drawFence(g, x, y, length, direction) {
  if (direction === 'horizontal') {
    fillRect(g, x, y + 7, length, 5, 0xc38a4b);
    fillRect(g, x, y + 21, length, 5, 0xc38a4b);
    for (let px = x; px <= x + length; px += 24) drawFencePost(g, px, y);
    return;
  }
  fillRect(g, x + 7, y, 5, length, 0xc38a4b);
  fillRect(g, x + 21, y, 5, length, 0xc38a4b);
  for (let py = y; py <= y + length; py += 24) drawFencePost(g, x, py);
}

function drawFencePost(g, x, y) {
  fillRect(g, x - 1, y - 1, 11, 31, 0x5e3f23);
  fillRect(g, x, y, 9, 29, 0x8d6337);
  fillRect(g, x + 2, y + 2, 4, 20, 0xe2b36e);
}

function drawShrubs(g) {
  const clusters = [
    [88, 132, 0x4c9b57], [132, 132, 0x63ad5f], [270, 250, 0x6cad58],
    [360, 604, 0x4f9f65], [392, 600, 0x76ba62], [700, 134, 0x4f9f65],
    [754, 154, 0x70b65c], [912, 248, 0x5fa859], [988, 556, 0x6fb45f],
    [596, 620, 0x4e9957], [552, 98, 0x6aaa58], [166, 258, 0x5fa859]
  ];
  for (const [x, y, color] of clusters) {
    fillRect(g, x - 4, y + 21, 46, 8, 0x365f39, 0.22);
    fillRect(g, x, y + 12, 15, 15, color);
    fillRect(g, x + 10, y + 4, 20, 20, color);
    fillRect(g, x + 28, y + 13, 14, 14, color);
    fillRect(g, x + 6, y + 18, 25, 7, 0x3f7d42);
  }
}

function drawFlowers(g) {
  const points = [
    [250, 142, 0xffd86f], [310, 560, 0xf38aa5], [708, 190, 0xf38aa5],
    [908, 178, 0xffd86f], [126, 576, 0xf38aa5], [910, 612, 0xeff6a0],
    [44, 226, 0xf38aa5], [72, 246, 0xffd86f], [238, 610, 0xeff6a0],
    [520, 636, 0xf38aa5], [1008, 316, 0xffd86f], [976, 276, 0xf38aa5],
    [842, 636, 0xeff6a0], [634, 106, 0xffd86f]
  ];
  for (const [x, y, color] of points) {
    fillRect(g, x, y, 6, 6, color);
    fillRect(g, x + 8, y, 6, 6, color);
    fillRect(g, x + 4, y - 5, 6, 6, color);
    fillRect(g, x + 4, y + 5, 6, 6, color);
    fillRect(g, x + 6, y + 10, 3, 12, 0x6d9b57);
  }
}

function drawSignPosts(g) {
  for (const [x, y, mark] of [[148, 318, 'in'], [610, 338, 'go'], [900, 354, 'out']]) {
    fillRect(g, x, y, 8, 38, 0x6b4b2d);
    fillRounded(g, x - 18, y - 4, 44, 22, 3, 0xd79d58);
    fillRect(g, x - 10, y + 4, mark === 'go' ? 26 : 18, 4, 0x4f3521);
    if (mark === 'out') fillRect(g, x + 10, y, 8, 4, 0x4f3521);
  }
}

function fillRect(g, x, y, width, height, color, alpha = 1) {
  g.beginFill(color, alpha).drawRect(x, y, width, height).endFill();
}

function fillRounded(g, x, y, width, height, radius, color, alpha = 1) {
  g.beginFill(color, alpha).drawRoundedRect(x, y, width, height, radius).endFill();
}

function triangle(g, x1, y1, x2, y2, x3, y3, color, alpha = 1) {
  g.beginFill(color, alpha);
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.lineTo(x3, y3);
  g.lineTo(x1, y1);
  g.endFill();
}

function drawBulkArlo(g, x, y, color, mode, alpha = 1, time = 0) {
  const px = Math.round(x);
  const py = Math.round(y);
  const body = hexColor(color);
  const step = mode === 'walking' ? Math.sin(time / 180 + px * 0.03) : 0;
  fillRect(g, px - 9, py + 12, 21, 5, 0x2b402f, 0.16 * alpha);

  if (mode === 'dead') {
    fillRect(g, px - 12, py - 1, 25, 10, 0x1e2422, alpha);
    fillRect(g, px - 7, py - 8, 16, 8, 0x1e2422, alpha);
    fillRect(g, px - 10, py + 1, 21, 6, body, alpha);
    fillRect(g, px - 5, py - 6, 12, 5, body, alpha);
    fillRect(g, px - 3, py - 5, 8, 4, 0xfff7d7, alpha);
    fillRect(g, px - 2, py - 4, 2, 2, 0x222222, alpha);
    fillRect(g, px + 3, py - 4, 2, 2, 0x222222, alpha);
    return;
  }

  fillRect(g, px - 8, py - 16, 17, 25, 0x1e2422, alpha);
  fillRect(g, px - 12, py - 7, 6, 11, 0x1e2422, alpha);
  fillRect(g, px + 8, py - 7, 6, 11, 0x1e2422, alpha);
  fillRect(g, px - 7, py + 8, 5, 8 + Math.max(0, step * 2), 0x1e2422, alpha);
  fillRect(g, px + 4, py + 8, 5, 8 + Math.max(0, -step * 2), 0x1e2422, alpha);
  fillRect(g, px - 6, py - 13, 13, 20, mode === 'prison' ? 0xf7f7f7 : body, alpha);
  fillRect(g, px - 10, py - 5, 5, 7, mode === 'prison' ? 0xf7f7f7 : body, alpha);
  fillRect(g, px + 8, py - 5, 5, 7, mode === 'prison' ? 0xf7f7f7 : body, alpha);
  fillRect(g, px - 5, py + 9, 4, 6, mode === 'prison' ? 0xf7f7f7 : body, alpha);
  fillRect(g, px + 4, py + 9, 4, 6, mode === 'prison' ? 0xf7f7f7 : body, alpha);

  if (mode === 'prison') {
    fillRect(g, px - 6, py - 10, 13, 3, 0x111111, alpha);
    fillRect(g, px - 6, py - 3, 13, 3, 0x111111, alpha);
    fillRect(g, px - 6, py + 4, 13, 3, 0x111111, alpha);
    fillRect(g, px - 10, py - 2, 5, 3, 0x111111, alpha);
    fillRect(g, px + 8, py - 2, 5, 3, 0x111111, alpha);
  }

  fillRect(g, px - 4, py - 19, 10, 8, 0xfff7d7, alpha);
  fillRect(g, px - 2, py - 16, 2, 2, 0x222222, alpha);
  fillRect(g, px + 3, py - 16, 2, 2, 0x222222, alpha);

  if (mode === 'recovering') {
    fillRect(g, px + 7, py - 24, 10, 10, 0xf5f5f5, alpha);
    fillRect(g, px + 11, py - 23, 2, 8, 0xd94848, alpha);
    fillRect(g, px + 8, py - 20, 8, 2, 0xd94848, alpha);
  }
}

async function fetchLiveCache() {
  try {
    const [streamResponse, webhookResponse] = await Promise.all([
      fetch('/api/cache/streams', { headers: { accept: 'application/json' } }),
      fetch('/api/cache/webhooks/stats', { headers: { accept: 'application/json' } })
    ]);
    const streamBody = await streamResponse.json();
    const webhookBody = await webhookResponse.json();
    appState.streams = normalizeLiveStreams(streamBody.streams || []);
    appState.rejected = [];
    appState.webhookStats = webhookBody.windows ? webhookBody : emptyWebhookStats();
    appState.cacheUnavailable = Boolean(streamBody.unavailable || webhookBody.unavailable);
    ui.status.textContent = appState.cacheUnavailable ? 'live cache unavailable, showing last known state' : 'live realtime cache';
    ui.lastRefresh.textContent = new Date().toLocaleTimeString();
    renderStats();
  } catch (error) {
    appState.cacheUnavailable = true;
    ui.status.textContent = `live cache error: ${error.message}`;
  }
}

function setMode(mode) {
  appState.mode = mode;
  ui.dummyButton.classList.toggle('active', mode === 'dummy');
  ui.liveButton.classList.toggle('active', mode === 'live');
  ui.status.textContent = mode === 'dummy' ? 'dummy cache feed' : 'live realtime cache';
  if (mode === 'live') fetchLiveCache();
}

function applyDummySnapshot(snapshot) {
  appState.streams = snapshot.streams;
  appState.webhookStats = snapshot.webhookStats;
  appState.completed = snapshot.completed;
  appState.interrupted = snapshot.interrupted;
  appState.rejected = snapshot.rejected;
  appState.cacheUnavailable = false;
}

function renderStats() {
  const streams = appState.streams;
  const running = streams.filter(isRunningStream);
  const byRegion = countBy(running, (stream) => normalizeRegion(stream.state?.regionCode || stream.state?.routeGroup));
  const mediaMiB = streams.reduce((sum, stream) => sum + mediaBytes(stream.metrics || {}), 0) / 1024 / 1024;
  const webhookLatency = latencyAverage(streams, 'webhook_ingress_latency_ms');
  const rttLatency = latencyAverage(streams, 'signaling_ping_rtt_ms');
  const rttMax = latencyMax(streams, 'signaling_ping_rtt_ms');

  ui.concurrent.textContent = String(running.length);
  ui.pods.textContent = String(running.filter((stream) => progressForStream(stream) < 0.96).length);
  ui.completed.textContent = `${appState.completed} / ${appState.interrupted}`;
  ui.media.textContent = `${mediaMiB.toFixed(mediaMiB >= 10 ? 0 : 1)} MiB`;
  ui.latencyWebhook.textContent = `${Math.round(webhookLatency)} ms`;
  ui.latencyRtt.textContent = `${Math.round(rttLatency)} ms`;
  ui.latencyRttMax.textContent = `${Math.round(rttMax)} ms`;
  ui.lastRefresh.textContent = appState.mode === 'dummy'
    ? 'simulated now'
    : (appState.cacheUnavailable ? 'cache unavailable' : new Date().toLocaleTimeString());

  renderRegionBars(byRegion, running.length);
  renderWebhookStats(appState.webhookStats);
  renderConcurrencyAlert(appState.webhookStats);
  renderStreamList(streams);
}

function renderRegionBars(byRegion, total) {
  ui.regions.innerHTML = '';
  for (const [regionId, region] of Object.entries(REGION_STYLES)) {
    if (regionId === 'unknown') continue;
    const count = Number(byRegion.get(regionId) || 0);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span>${region.label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${total ? Math.max(8, (count / total) * 100) : 0}%;background:#${region.color.toString(16).padStart(6, '0')}"></div></div>
      <strong>${count}</strong>
    `;
    ui.regions.appendChild(row);
  }
}

function renderWebhookStats(stats) {
  const window = stats?.windows?.find((entry) => entry.key === '1m') || stats?.windows?.[0] || emptyWebhookStats().windows[0];
  const labels = [
    ['total', 'total'],
    ['concurrency_limited', 'limited'],
    ['accepted', 'accepted'],
    ['unverified', 'unsigned'],
    ['duplicate', 'dupes']
  ];
  ui.webhookStats.innerHTML = '';
  for (const [key, label] of labels) {
    const cell = document.createElement('div');
    cell.className = 'webhook-cell';
    cell.innerHTML = `<span>${label}</span><strong>${Number(window.counts?.[key] || 0)}</strong>`;
    ui.webhookStats.appendChild(cell);
  }
}

function renderConcurrencyAlert(stats) {
  const recent = stats?.windows?.find((entry) => entry.key === '1m') || stats?.windows?.[0] || null;
  const count = Number(recent?.counts?.concurrency_limited || 0);
  if (!ui.concurrencyAlert) return;
  ui.concurrencyAlert.hidden = count <= 0;
  if (count > 0 && ui.concurrencyAlertDetail) {
    ui.concurrencyAlertDetail.textContent = `${count.toLocaleString()} concurrency-limited RTMS webhook${count === 1 ? '' : 's'} in the past minute.`;
  }
}

function renderStreamList(streams) {
  ui.streamList.innerHTML = '';
  if (!streams.length) {
    ui.streamList.innerHTML = '<span class="empty-list">No active Arlos yet.</span>';
    return;
  }
  for (const stream of streams.slice(0, 9)) {
    const region = normalizeRegion(stream.state?.regionCode || stream.state?.routeGroup);
    const stage = stream.interrupted
      ? { label: 'Interrupted' }
      : (stream.reconnecting
          ? { label: 'Reconnecting' }
          : STAGES[Math.min(STAGES.length - 1, Math.floor(progressForStream(stream) * (STAGES.length - 1)))]);
    const paletteIndex = hashString(stream.streamId) % STREAM_PALETTE.length;
    const row = document.createElement('div');
    row.className = 'stream-row';
    row.innerHTML = `
      <span class="stream-dot" style="background:${STREAM_PALETTE[paletteIndex]}"></span>
      <div><strong>${escapeHtml(stream.streamId)}</strong><span>${REGION_STYLES[region]?.label || region}</span></div>
      <span>${stage.label}</span>
    `;
    ui.streamList.appendChild(row);
  }
}

function showNodeDialog(nodeId) {
  if (nodeId.startsWith('region:')) {
    const [, regionId, component] = nodeId.split(':');
    const region = REGION_STYLES[regionId] || REGION_STYLES.unknown;
    if (component) {
      const componentInfo = NODE_INFO[component];
      setDialog(`${region.label} ${componentInfo?.title || component}`, componentInfo?.body || `This is the ${component} layer for ${region.label}.`);
      return;
    }
    setDialog(region.label, `This regional lodge represents the selected spoke and nearby compute launcher for ${region.label}.`);
    return;
  }
  const node = NODE_INFO[nodeId];
  if (node) setDialog(node.title, node.body);
}

function showStreamDialog(streamId) {
  const stream = appState.streams.find((item) => item.streamId === streamId);
  if (!stream) return;
  const region = REGION_STYLES[normalizeRegion(stream.state?.regionCode)] || REGION_STYLES.unknown;
  const stage = stream.interrupted
    ? { label: 'Interrupted, heading to graveyard' }
    : (stream.reconnecting
        ? { label: 'Intermittently disconnected, trying to reconnect' }
        : STAGES[Math.min(STAGES.length - 1, Math.floor(progressForStream(stream) * (STAGES.length - 1)))]);
  const mediaMiB = mediaBytes(stream.metrics || {}) / 1024 / 1024;
  setDialog(`Arlo ${streamId}`, `${region.label} - ${stage.label}. Media counted: ${mediaMiB.toFixed(1)} MiB. ${stream.summary?.text || 'No live summary yet.'}`);
}

function setDialog(title, body) {
  ui.dialog.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
}

function routeForStream(stream) {
  if (stream.interrupted && Array.isArray(stream.burialRoute) && stream.burialRoute.length >= 2) return stream.burialRoute;
  if (stream.reconnecting && Array.isArray(stream.hospitalRoute) && stream.hospitalRoute.length >= 2) return stream.hospitalRoute;
  const regionId = normalizeRegion(stream.state?.regionCode || stream.state?.routeGroup);
  const region = REGION_STYLES[regionId] || REGION_STYLES.unknown;
  const workshops = REGION_WORKSHOPS[regionId] || REGION_WORKSHOPS.unknown;
  return [
    { x: -28, y: 382 },
    { x: 78, y: 382 },
    { x: 202, y: 360 },
    { x: 334, y: 360 },
    { x: region.x, y: region.y },
    workshops.k8s,
    workshops.pod,
    workshops.cache,
    workshops.logs,
    { x: 956, y: 402 }
  ];
}

function routeForRejected(event) {
  const destination = event.type === 'duplicate' ? POLICE_STATION.duplicatePen : POLICE_STATION.unsignedPen;
  return [
    { x: -22, y: 382 },
    { x: 78, y: 382 },
    { x: 88, y: 300 },
    destination
  ];
}

function graveDestinationForStream(streamId) {
  const slot = GRAVEYARD.slots[hashString(streamId) % GRAVEYARD.slots.length];
  return { x: GRAVEYARD.x + slot.x, y: GRAVEYARD.y + slot.y };
}

function progressForStream(stream) {
  if (stream.interrupted && Number.isFinite(Number(stream.burialProgress))) return Number(stream.burialProgress);
  if (stream.reconnecting && Number.isFinite(Number(stream.reconnectProgress))) return Number(stream.reconnectProgress);
  if (Number.isFinite(Number(stream.progress))) return Number(stream.progress);
  return progressForLiveState(stream, 0);
}

function progressForLiveState(stream, index) {
  const state = String(stream.state?.state || '').toLowerCase();
  const eventTypes = (stream.events || []).map((event) => String(event.type || '').toLowerCase());
  if (state.includes('accepted') || state.includes('received')) return 0.08 + index * 0.01;
  if (state.includes('route') || state.includes('handoff')) return 0.22;
  if (state.includes('launch')) return 0.46;
  if (state.includes('reconnect')) return 0.58;
  if (state.includes('claim') || state.includes('connect')) return 0.62;
  if (eventTypes.some((type) => type.includes('artifact') || type.includes('final'))) return 1;
  if (state === 'artifact_saved' || state === 'stopped' || state === 'terminated') return 0.96;
  if (state.includes('stop') || state.includes('ended') || state.includes('completed')) return 0.9;
  if (state.includes('connected') || state.includes('running') || state.includes('active')) return 0.7;
  return 0.5;
}

function stateFromProgress(progress) {
  if (progress < 0.18) return 'accepted';
  if (progress < 0.34) return 'routed';
  if (progress < 0.48) return 'regional_handoff';
  if (progress < 0.62) return 'job_launching';
  if (progress < 0.78) return 'connected';
  if (progress < 0.92) return 'finalizing';
  return 'artifact_saved';
}

function progressSpeedMultiplier(progress) {
  if (progress < 0.24) return 2.15;
  if (progress < 0.48) return 1.55;
  if (progress < 0.74) return 0.72;
  if (progress < 0.92) return 1.85;
  return 2.4;
}

function pointAlongRoute(points, progress) {
  const clamped = clamp(progress, 0, 1);
  const scaled = clamped * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(scaled));
  const local = scaled - index;
  return {
    x: lerp(points[index].x, points[index + 1].x, local),
    y: lerp(points[index].y, points[index + 1].y, local)
  };
}

function normalizeLiveStreams(streams) {
  return streams
    .filter((stream) => isVisibleStream(stream))
    .map((stream, index) => ({
      ...stream,
      progress: progressForLiveState(stream, index),
      completed: isExitAnimationStream(stream),
      state: {
        ...(stream.state || {}),
        regionCode: normalizeRegion(stream.state?.regionCode || stream.state?.routeGroup || firstLatencyRegion(stream.latency))
      },
      metrics: stream.metrics || {},
      latency: stream.latency || {}
    }));
}

function isVisibleStream(stream) {
  return isActiveStream(stream) || isExitAnimationStream(stream);
}

function isActiveStream(stream) {
  const state = String(stream?.state?.state || '').toLowerCase();
  if (!state) return false;
  const updatedAt = Date.parse(stream.updatedAt || stream.state?.updatedAt || stream.createdAt || '');
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > LIVE_STREAM_STALE_MS) return false;
  return !isTerminalStreamState(state);
}

function isExitAnimationStream(stream) {
  const state = String(stream?.state?.state || '').toLowerCase();
  if (!isTerminalStreamState(state)) return false;

  const updatedAt = Date.parse(stream.updatedAt || stream.state?.updatedAt || stream.createdAt || '');
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > TERMINAL_EXIT_ANIMATION_MS) return false;

  if (state === 'failed' || state === 'reconnect_failed') return false;
  if (hasFinalArtifactEvent(stream)) {
    const artifactAt = lastFinalArtifactEventAt(stream) || updatedAt;
    return Date.now() - artifactAt <= COMPLETED_STORAGE_HOLD_MS;
  }

  return state.includes('stop') ||
    state.includes('ended') ||
    state.includes('completed') ||
    state === 'terminated' ||
    state === 'artifact_saved';
}

function isTerminalStreamState(state) {
  return [
    'stopping',
    'stopped',
    'stop_requested',
    'ended',
    'terminated',
    'failed',
    'completed',
    'dry_run_completed',
    'artifact_saved',
    'reconnect_failed'
  ].includes(state);
}

function hasFinalArtifactEvent(stream) {
  return Boolean(lastFinalArtifactEventAt(stream));
}

function lastFinalArtifactEventAt(stream) {
  const events = stream.events || [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const type = String(event.type || '').toLowerCase();
    if (!type.includes('artifact') && !type.includes('final')) continue;
    const at = Date.parse(event.at || event.createdAt || event.updatedAt || '');
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

function isRunningStream(stream) {
  const state = String(stream?.state?.state || '').toLowerCase();
  return isActiveStream(stream) &&
    !stream?.interrupted &&
    !stream?.completed &&
    !['interrupted', 'reconnect_failed', 'artifact_saved'].includes(state);
}

function normalizeRegion(value) {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('sjc') || raw.includes('west')) return 'amer-west';
  if (raw.includes('iad') || raw.includes('yyz') || raw.includes('east') || raw === 'us') return 'amer-east';
  if (raw.includes('ams') || raw.includes('fra') || raw.includes('europe')) return 'europe';
  if (raw.includes('sin') || raw.includes('nrt') || raw.includes('hkg') || raw.includes('syd') || raw.includes('mel') || raw.includes('apac')) return 'apac-hub';
  return 'unknown';
}

function dummyWebhookStats(activeCount, completedCount, rejectedEvents = []) {
  const base = activeCount + completedCount;
  const rejectedUnsigned = rejectedEvents.filter((event) => event.type === 'unsigned').length;
  const rejectedDuplicate = rejectedEvents.filter((event) => event.type === 'duplicate').length;
  return {
    windows: [
      { key: '1m', label: 'Past minute', counts: { total: base + rejectedUnsigned + rejectedDuplicate, accepted: base, unverified: rejectedUnsigned, duplicate: rejectedDuplicate, concurrency_limited: 0 } },
      { key: '60m', label: 'Past 60 minutes', counts: { total: base * 4 + 12, accepted: base * 4 + 8, unverified: rejectedUnsigned + 2, duplicate: rejectedDuplicate + 2, concurrency_limited: 1 } },
      { key: '24h', label: 'Past 24 hours', counts: { total: base * 18 + 80, accepted: base * 18 + 64, unverified: rejectedUnsigned + 6, duplicate: rejectedDuplicate + 10, concurrency_limited: 3 } }
    ]
  };
}

function emptyWebhookStats() {
  return {
    windows: [
      { key: '1m', label: 'Past minute', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } },
      { key: '60m', label: 'Past 60 minutes', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } },
      { key: '24h', label: 'Past 24 hours', counts: { total: 0, accepted: 0, unverified: 0, duplicate: 0, concurrency_limited: 0 } }
    ]
  };
}

function mediaBytes(metrics) {
  return Number(metrics.audio_bytes_total || 0) +
    Number(metrics.video_bytes_total || 0) +
    Number(metrics.screen_share_bytes_total || 0);
}

function latencyAverage(streams, name) {
  const stats = streams.map((stream) => stream.latency?.[name]).filter(Boolean);
  if (!stats.length) return 0;
  return stats.reduce((sum, stat) => sum + Number(stat.avgMs || stat.lastMs || 0), 0) / stats.length;
}

function latencyMax(streams, name) {
  return streams.reduce((max, stream) => Math.max(max, Number(stream.latency?.[name]?.maxMs || stream.latency?.[name]?.lastMs || 0)), 0);
}

function latencyStat(name, valueMs, regionCode) {
  return {
    name,
    unit: 'ms',
    count: 1,
    sumMs: valueMs,
    minMs: valueMs,
    maxMs: valueMs,
    avgMs: valueMs,
    lastMs: valueMs,
    regionCode
  };
}

function firstLatencyRegion(latency = {}) {
  for (const value of Object.values(latency || {})) {
    if (value?.regionCode) return value.regionCode;
  }
  return 'unknown';
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`failed to load ${src}`));
    image.src = src;
  });
}

function textureKey(paletteIndex, frameIndex) {
  return `arlo-p${paletteIndex}-f${frameIndex}`;
}

function initialArloTexture(paletteIndex, stream) {
  if (stream.interrupted) return deadTextureKey(paletteIndex);
  if (stream.reconnecting) return recoveringTextureKey(paletteIndex);
  return textureKey(paletteIndex, 15);
}

function deadTextureKey(paletteIndex) {
  return `arlo-p${paletteIndex}-dead`;
}

function recoveringTextureKey(paletteIndex) {
  return `arlo-p${paletteIndex}-recovering`;
}

function prisonTextureKey() {
  return 'arlo-prison-striped';
}

function createDeadArloCanvas(rgb) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 64, 64);
  context.fillStyle = 'rgba(36,52,40,0.25)';
  context.fillRect(12, 49, 42, 8);
  context.fillStyle = '#1e2422';
  context.fillRect(14, 30, 40, 16);
  context.fillRect(20, 22, 26, 16);
  context.fillRect(10, 36, 10, 8);
  context.fillRect(48, 36, 10, 8);
  context.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
  context.fillRect(17, 31, 34, 12);
  context.fillRect(23, 25, 20, 11);
  context.fillRect(13, 37, 7, 5);
  context.fillRect(48, 37, 7, 5);
  context.fillStyle = '#fff7d7';
  context.fillRect(25, 28, 16, 9);
  context.strokeStyle = '#222222';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(27, 29);
  context.lineTo(31, 33);
  context.moveTo(31, 29);
  context.lineTo(27, 33);
  context.moveTo(35, 29);
  context.lineTo(39, 33);
  context.moveTo(39, 29);
  context.lineTo(35, 33);
  context.stroke();
  return canvas;
}

function createRecoveringArloCanvas(rgb) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 64, 64);
  context.fillStyle = 'rgba(36,52,40,0.22)';
  context.fillRect(15, 52, 36, 7);
  context.fillStyle = '#1e2422';
  context.fillRect(20, 20, 24, 28);
  context.fillRect(16, 31, 8, 12);
  context.fillRect(42, 31, 8, 12);
  context.fillStyle = `rgb(${rgb.r},${rgb.g},${rgb.b})`;
  context.fillRect(23, 23, 18, 23);
  context.fillRect(18, 33, 7, 8);
  context.fillRect(41, 33, 7, 8);
  context.fillStyle = '#fff7d7';
  context.fillRect(25, 17, 15, 12);
  context.fillStyle = '#222222';
  context.fillRect(28, 22, 3, 3);
  context.fillRect(35, 22, 3, 3);
  context.fillStyle = '#f5f5f5';
  context.fillRect(39, 11, 16, 16);
  context.fillStyle = '#d94848';
  context.fillRect(45, 13, 4, 12);
  context.fillRect(41, 17, 12, 4);
  return canvas;
}

function createPrisonArloCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, 64, 64);
  context.fillStyle = 'rgba(36,52,40,0.22)';
  context.fillRect(15, 52, 36, 7);
  context.fillStyle = '#1e2422';
  context.fillRect(20, 20, 24, 28);
  context.fillRect(16, 31, 8, 12);
  context.fillRect(42, 31, 8, 12);
  context.fillStyle = '#f7f7f7';
  context.fillRect(23, 23, 18, 23);
  context.fillRect(18, 33, 7, 8);
  context.fillRect(41, 33, 7, 8);
  context.fillStyle = '#111111';
  for (let y = 24; y <= 44; y += 7) {
    context.fillRect(23, y, 18, 3);
    context.fillRect(18, y + 2, 7, 3);
    context.fillRect(41, y + 2, 7, 3);
  }
  context.fillStyle = '#fff7d7';
  context.fillRect(25, 17, 15, 12);
  context.fillStyle = '#222222';
  context.fillRect(28, 22, 3, 3);
  context.fillRect(35, 22, 3, 3);
  context.fillStyle = '#111111';
  context.fillRect(22, 12, 21, 5);
  context.fillRect(25, 9, 15, 4);
  return canvas;
}

function nearbyDarkPixels(imageData, width, height, centerX, centerY) {
  let count = 0;
  for (let y = Math.max(0, centerY - 8); y <= Math.min(height - 1, centerY + 8); y += 2) {
    for (let x = Math.max(0, centerX - 8); x <= Math.min(width - 1, centerX + 8); x += 2) {
      const offset = (y * width + x) * 4;
      const lum = (imageData.data[offset] + imageData.data[offset + 1] + imageData.data[offset + 2]) / 3;
      if (lum < 90) count += 1;
    }
  }
  return count;
}

function countBy(items, getKey) {
  const map = new Map();
  for (const item of items) {
    const key = getKey(item);
    map.set(key, Number(map.get(key) || 0) + 1);
  }
  return map;
}

function stressCountFromUrl() {
  const raw = Number(new URLSearchParams(window.location.search).get('stress') || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return clamp(Math.floor(raw), 1, 250);
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '');
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16)
  };
}

function hexColor(hex) {
  return parseInt(String(hex).replace('#', ''), 16);
}

function hashString(value) {
  let hash = 0;
  for (const char of String(value || '')) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return Math.abs(hash);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
