// Solar's Code Rain by Solartunic2009: audio-reactive background shared by the profile pages.
// Site pages have no music, so they pass a color. Removing the canvas stops either rain.

function startVisualizer(tint) {
    const canvas = document.getElementById('matrix-bg');
    canvas.style.display = 'block';
    const ctx = canvas.getContext('2d');

    // The back layer is drawn small and scaled up, which softens it for almost no GPU work.
    // Don't use ctx.filter here: it re-renders per letter and saturates even fast GPUs.
    const BACK_SCALE = 1 / 3;
    const backCanvas = document.createElement('canvas');
    const backCtx = backCanvas.getContext('2d');

    const resize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        backCanvas.width = Math.ceil(canvas.width * BACK_SCALE);
        backCanvas.height = Math.ceil(canvas.height * BACK_SCALE);
    };
    resize();
    window.addEventListener('resize', resize);

    const chars = '01アイウエオカキクケコ{}[]<>/\\|';
    const size = 14;
    let bass = 0, mids = 0, highs = 0, kickEnergy = 0, snareEnergy = 0;
    let audioConnected = false, analyserNode = null, audioData = null;

    function hookAudio() {
        if (audioConnected) return;
        const audioEl = document.getElementById('p-audio') || document.getElementById('audio');
        if (!audioEl) return;
        try {
            const audioCtx = new AudioContext();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 512;
            const source = audioCtx.createMediaElementSource(audioEl);
            source.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);
            audioData = new Uint8Array(analyserNode.frequencyBinCount);
            audioConnected = true;
        } catch(e) {}
    }

    document.addEventListener('click', hookAudio, { once: true });

    const layers = [{ speed: 0.9, opacity: 0.24 }, { speed: 1.6, opacity: 0.75 }];
    const createLayerData = () => {
        const cols = Math.floor(canvas.width / size);
        return { cols, drops: Array.from({ length: cols }, () => ({ y: Math.random() * -80, speed: 1 + Math.random() * 1.5, burst: 0 })) };
    };
    const layerData = layers.map(createLayerData);

    function hslToRgb(h, s, l) {
        h /= 360; let r, g, b;
        if (s === 0) { r = g = b = l; } else {
            const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q-p)*6*t; if (t < 1/2) return q; if (t < 2/3) return p + (q-p)*(2/3-t)*6; return p; };
            const q = l < 0.5 ? l*(1+s) : l+s-l*s, p = 2*l-q;
            r = hue2rgb(p,q,h+1/3); g = hue2rgb(p,q,h); b = hue2rgb(p,q,h-1/3);
        }
        return [r*255, g*255, b*255];
    }

    let mouseX = 0, mouseY = 0, tiltX = 0, tiltY = 0;
    window.addEventListener('mousemove', e => {
        mouseX = e.clientX; mouseY = e.clientY;
        tiltX = (e.clientY - window.innerHeight/2) / (window.innerHeight/2);
        tiltY = (e.clientX - window.innerWidth/2) / (window.innerWidth/2);
    });

    function drawLayer(target, layer, config) {
        target.font = `${size}px JetBrains Mono, monospace`;
        const [r,g,b_] = tint || hslToRgb(mids*360, 1, Math.min(0.9, 0.4 + bass*0.6));
        const sn = snareEnergy > 0.05 ? snareEnergy*150 : 0;
        for (let i = 0; i < layer.cols; i++) {
            const drop = layer.drops[i];
            const dx = i*size - mouseX, dy = drop.y*size - mouseY;
            const dist = Math.sqrt(dx*dx + dy*dy);
            const midDistortion = Math.sin(dist*0.015) * (4 + mids*20);
            const alpha = config.opacity * (0.4 + Math.random()*0.6 + bass*2.5);
            const flicker = highs > 0.1 && Math.random() < highs*1.5 ? 15 : 0;
            target.fillStyle = `rgba(${Math.min(255,r+sn+flicker)},${Math.min(255,g+sn+flicker)},${Math.min(255,b_+sn+flicker)},${alpha})`;
            if (kickEnergy > 0.05) drop.y -= kickEnergy*2.5;
            target.fillText(chars[Math.floor(Math.random()*chars.length)], i*size + midDistortion, drop.y*size + midDistortion);
            if (Math.random() < 0.002 && drop.burst === 0) drop.burst = 20 + Math.random()*20;
            if (drop.burst > 0) { drop.burst--; drop.speed += 0.15; }
            if (drop.y*size > canvas.height && Math.random() > 0.975) { drop.y = Math.random()*-40; drop.speed = 1 + Math.random()*1.5; }
            drop.y += drop.speed * config.speed;
        }
    }

    // Rain moves per frame, so this cap also keeps its speed the same on every monitor.
    // The margin stops rAF timing jitter from dropping 60Hz screens to 20fps.
    const FRAME_MS = 1000 / 30;
    let lastFrame = 0;

    function loop(now) {
        if (!canvas.isConnected) return;
        requestAnimationFrame(loop);
        if (now - lastFrame < FRAME_MS - 4) return;
        lastFrame = now;

        if (analyserNode && audioData) {
            analyserNode.getByteFrequencyData(audioData);
            const len = audioData.length, be = Math.floor(len*0.12), me = Math.floor(len*0.5);
            const avg = (s,e) => { let sum=0; for(let i=s;i<e;i++) sum+=audioData[i]; return (sum/(e-s))/255; };
            bass = avg(0,be); mids = avg(be,me); highs = avg(me,len);
            kickEnergy = Math.max(0, bass-0.25); snareEnergy = Math.max(0, mids-0.35);
        }
        const sx = kickEnergy > 0 ? (Math.random()-0.5)*kickEnergy*20 : 0;
        const sy = kickEnergy > 0 ? (Math.random()-0.5)*kickEnergy*20 : 0;
        ctx.setTransform(1,0,0,1,0,0);
        ctx.fillStyle = 'rgba(0,0,0,0.20)'; ctx.fillRect(0,0,canvas.width,canvas.height);
        ctx.setTransform(1, tiltX*0.05, tiltY*0.05, 1, sx, sy);
        layerData.forEach((layer, idx) => {
            const expected = Math.floor(canvas.width/size);
            if (layer.cols !== expected) layerData[idx] = createLayerData();
        });

        backCtx.setTransform(BACK_SCALE, 0, 0, BACK_SCALE, 0, 0);
        backCtx.clearRect(0, 0, canvas.width, canvas.height);
        drawLayer(backCtx, layerData[0], layers[0]);
        ctx.drawImage(backCanvas, 0, 0, canvas.width, canvas.height);

        drawLayer(ctx, layerData[1], layers[1]);
    }
    requestAnimationFrame(loop);
}

function startMatrix(tint = [255, 255, 255]) {
    const canvas = document.getElementById('matrix-bg');
    canvas.style.display = 'block';
    const resize = () => { canvas.width = window.innerWidth; canvas.height = window.innerHeight; };
    resize();
    window.addEventListener('resize', resize);
    const ctx = canvas.getContext('2d');
    const chars = '01アイウエオカキクケコサシスセソタチツテト{}[]<>/\\|';
    const size = 13;
    let cols = Math.floor(canvas.width / size);
    let drops = Array.from({ length: cols }, () => Math.random() * -60);
    const timer = setInterval(() => {
        if (!canvas.isConnected) return clearInterval(timer);
        cols = Math.floor(canvas.width / size);
        if (drops.length !== cols) drops = Array.from({ length: cols }, () => Math.random() * -60);
        ctx.fillStyle = 'rgba(0,0,0,0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = size + 'px JetBrains Mono, monospace';
        for (let i = 0; i < drops.length; i++) {
            ctx.fillStyle = `rgba(${tint},${(Math.random() * 0.12 + 0.04).toFixed(2)})`;
            ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * size, drops[i] * size);
            if (drops[i] * size > canvas.height && Math.random() > 0.975) drops[i] = 0;
            drops[i]++;
        }
    }, 50);
}
