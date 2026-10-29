import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert, toDataView } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('ISOBMFF muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Fragmented fMP4 with video+audio preserves B-frame CTS', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const originalVideoSink = new EncodedPacketSink(videoTrack);
	const originalTimestamps: number[] = [];
	for await (const packet of originalVideoSink.packets()) {
		originalTimestamps.push(packet.timestamp);
	}

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputVideoTrack = await outputAsInput.getPrimaryVideoTrack();
	assert(outputVideoTrack);

	const videoSink = new EncodedPacketSink(outputVideoTrack);

	const timestamps: number[] = [];
	for await (const packet of videoSink.packets()) {
		timestamps.push(packet.timestamp);
	}

	expect(timestamps).toEqual(originalTimestamps);
});

test('Zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 0.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);
});

test('Non-zero start timestamp, regular MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') && str.includes('elst')).toBe(true);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Non-zero start timestamp, fragmented MP4', async () => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 0.1), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.1, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.2, 0.1));
	await source.add(new EncodedPacket(new Uint8Array(1024), 'delta', 1.3, 0.1));

	await output.finalize();

	// Hacky but works
	const str = String.fromCharCode(...new Uint8Array(output.target.buffer!));
	expect(str.includes('edts') || str.includes('elst')).toBe(false);

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const timestamps: number[] = [];
	const durations: number[] = [];
	for await (const packet of sink.packets()) {
		timestamps.push(packet.timestamp);
		durations.push(packet.duration);
	}

	expect(timestamps).toEqual([1, 1.1, 1.2, 1.3]);
	expect(durations).toEqual([0.1, 0.1, 0.1, 0.1]);
});

test('Negative start timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, false);
});

test('Negative start timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip(Array.from({ length: 50 }, (_, index) => (index - 10) / 10), 0.1, true);
});

test('Wholly negative timestamps, regular MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, false);
});

test('Wholly negative timestamps, fragmented MP4', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, true);
});

const testNegativeTimestampRoundTrip = async (
	timestamps: number[],
	duration: number,
	fragmented: boolean,
) => {
	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: fragmented ? 'fragmented' : false }),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate: 10 });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

test('PCM audio', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(0);
});

test('PCM audio with non-zero timestamp', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getFirstTimestamp()).toBe(1);
});

test('PCM audio, silence padding', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 1, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 48000 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

test('PCM audio, no silence padding with approximate timestamps', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedAudioPacketSource('pcm-s16');
	output.addAudioTrack(source);

	await output.start();

	const meta = { decoderConfig: { codec: 'pcm-s16', numberOfChannels: 2, sampleRate: 48000 } };

	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 1024 / 2 / 2 / 48000), meta);
	// 0.006 is 256/48000 "rounded up", but it's close enough for silence padding not to kick in
	await source.add(new EncodedPacket(new Uint8Array(1024), 'key', 0.006, 1024 / 2 / 2 / 48000), meta);

	await output.finalize();

	const input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);

	expect(await audioTrack.getCodec()).toBe('pcm-s16');
	const numChannels = await audioTrack.getNumberOfChannels();

	const expectedFrameCount = 256 + 256;
	const sink = new EncodedPacketSink(audioTrack);
	let frameCount = 0;

	for await (const packet of sink.packets()) {
		frameCount += packet.byteLength / 2 / numChannels;
	}

	expect(frameCount).toBe(expectedFrameCount);
});

// https://github.com/Vanilagy/mediabunny/pull/391
test('At least one track is enabled even if all are added disabled', async () => {
	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };

	const source1 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source1, { disposition: { default: false } });

	const source2 = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source2, { disposition: { default: false } });

	await output.start();

	await source1.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);
	await source2.add(new EncodedPacket(new Uint8Array(1024), 'key', 0, 0.1), meta);

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const tracks = await input.getVideoTracks();
	expect(tracks.length).toBe(2);

	// Even though both tracks were added disabled, the muxer forces the first one to be enabled
	expect((await tracks[0]!.getDisposition()).default).toBe(true);
	expect((await tracks[1]!.getDisposition()).default).toBe(false);
});

test('btrt boxes computed from packet sizes, regular MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat());
	const boxes = findBtrtBoxes(bytes);

	expect(boxes).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 3261384,
			avgBitrate: 2858330,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 318224,
			avgBitrate: 317375,
		},
	]);

	using input = new Input({
		source: new BufferSource(bytes),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	expect(await videoTrack.getBitrate()).toBe(3261384);
	expect(await videoTrack.getAverageBitrate()).toBe(2858330);
	expect(await audioTrack.getBitrate()).toBe(318224);
	expect(await audioTrack.getAverageBitrate()).toBe(317375);
});

test('btrt boxes copied from input metadata in conversion, fragmented MP4', async () => {
	const bytes = await copyVideoMp4(new Mp4OutputFormat({ fastStart: 'fragmented' }));

	// These are equal to what was in the input file
	expect(findBtrtBoxes(bytes)).toEqual([
		{
			bufferSizeDB: 0,
			maxBitrate: 2858329,
			avgBitrate: 2858329,
		},
		{
			bufferSizeDB: 0,
			maxBitrate: 320000,
			avgBitrate: 317375,
		},
	]);
});

test('No btrt boxes, fragmented MP4 without bitrate metadata', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const videoTrack = await input.getPrimaryVideoTrack();
	const audioTrack = await input.getPrimaryAudioTrack();
	assert(videoTrack);
	assert(audioTrack);

	const output = new Output({
		format: new Mp4OutputFormat({ fastStart: 'fragmented' }),
		target: new BufferTarget(),
	});

	const videoSource = new EncodedVideoPacketSource((await videoTrack.getCodec())!);
	const audioSource = new EncodedAudioPacketSource((await audioTrack.getCodec())!);
	output.addVideoTrack(videoSource);
	output.addAudioTrack(audioSource);

	await output.start();

	const videoMeta = { decoderConfig: (await videoTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		await videoSource.add(packet, videoMeta);
	}

	const audioMeta = { decoderConfig: (await audioTrack.getDecoderConfig())! };
	for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
		await audioSource.add(packet, audioMeta);
	}

	await output.finalize();

	expect(findBtrtBoxes(new Uint8Array(output.target.buffer!))).toEqual([]);
});

test('Annex B AVC resolution changes get their own sample descriptions', async () => {
	const square = await readVideoPackets('0.ts'); // 720x720
	const fullHd = await readVideoPackets('trim-buck-bunny-ffmpeg.ts'); // 1920x1080

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	// Back to back: 720x720, 1920x1080, 720x720
	let offset = 0;
	for (const clip of [square, fullHd, square]) {
		const start = clip.packets[0]!.timestamp;
		for (const packet of clip.packets) {
			await videoSource.add(
				packet.clone({ timestamp: packet.timestamp - start + offset }),
				{ decoderConfig: square.decoderConfig },
			);
		}
		offset += clip.packets.at(-1)!.timestamp + 1 - start;
	}
	await output.finalize();

	expect(readSampleDescriptions(new Uint8Array(output.target.buffer!))).toEqual({
		sizes: [[720, 720], [1920, 1080]],
		indices: [1, 2, 1],
	});
});

test('AVC decoder config changes get their own sample descriptions', async () => {
	const wide = await readVideoPackets('demo.mp4'); // 640x360
	const otherWide = await readVideoPackets('fragments-without-keyframes.mp4'); // 640x360, other SPS/PPS
	const large = await readVideoPackets('edts.mp4'); // 854x480

	const output = new Output({
		format: new Mp4OutputFormat(),
		target: new BufferTarget(),
	});
	const videoSource = new EncodedVideoPacketSource('avc');
	output.addVideoTrack(videoSource);
	await output.start();

	// Back to back, like a replaced encoder each time, with the decoder config of each clip on its key packet
	let offset = 0;
	for (const clip of [wide, otherWide, large, wide]) {
		const start = clip.packets[0]!.timestamp;
		for (const packet of clip.packets) {
			await videoSource.add(
				packet.clone({ timestamp: packet.timestamp - start + offset }),
				packet.type === 'key' ? { decoderConfig: clip.decoderConfig } : undefined,
			);
		}
		offset += clip.packets.at(-1)!.timestamp + 1 - start;
	}
	await output.finalize();

	expect(readSampleDescriptions(new Uint8Array(output.target.buffer!))).toEqual({
		sizes: [[640, 360], [640, 360], [854, 480]],
		indices: [1, 2, 3, 1],
	});
});

/** The size of each video sample description, and the chunks' sample description indices without repeats. */
const readSampleDescriptions = (bytes: Uint8Array) => {
	const view = toDataView(bytes);

	const stsd = findFourCc(bytes, 'stsd');
	const sizes: number[][] = [];
	for (let i = 0, pos = stsd + 16; i < view.getUint32(stsd + 12); i++, pos += view.getUint32(pos)) {
		sizes.push([view.getUint16(pos + 32), view.getUint16(pos + 34)]);
	}

	const stsc = findFourCc(bytes, 'stsc');
	const indices: number[] = [];
	for (let i = 0; i < view.getUint32(stsc + 12); i++) {
		const index = view.getUint32(stsc + 24 + 12 * i);
		if (index !== indices.at(-1)) {
			indices.push(index);
		}
	}

	return { sizes, indices };
};

/** The video packets of a file from its first key packet, up to its second one (if any). */
const readVideoPackets = async (fileName: string) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public', fileName)),
		formats: ALL_FORMATS,
	});
	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);

	const packets: EncodedPacket[] = [];
	for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
		if (packet.type === 'key' && packets.length > 0) {
			break;
		}
		if (packet.type === 'key' || packets.length > 0) {
			packets.push(packet);
		}
	}

	return { decoderConfig: (await videoTrack.getDecoderConfig())!, packets };
};

const findFourCc = (bytes: Uint8Array, fourCc: string) => {
	const codes = [...fourCc].map(x => x.charCodeAt(0));
	for (let i = 4; i < bytes.length - 4; i++) {
		if (codes.every((code, j) => bytes[i + j] === code)) {
			return i - 4; // Start of the box
		}
	}

	throw new Error(`No ${fourCc} box`);
};

const copyVideoMp4 = async (format: Mp4OutputFormat) => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/video.mp4')),
		formats: ALL_FORMATS,
	});

	const output = new Output({
		format,
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	return new Uint8Array(output.target.buffer!);
};

const findBtrtBoxes = (bytes: Uint8Array) => {
	const view = toDataView(bytes);
	const boxes: { bufferSizeDB: number; maxBitrate: number; avgBitrate: number }[] = [];

	for (let i = 0; i < bytes.length - 4; i++) {
		if (bytes[i] !== 0x62 || bytes[i + 1] !== 0x74 || bytes[i + 2] !== 0x72 || bytes[i + 3] !== 0x74) {
			continue;
		}

		const boxSize = view.getUint32(i - 4);
		expect(boxSize).toBe(20);

		boxes.push({
			bufferSizeDB: view.getUint32(i + 4),
			maxBitrate: view.getUint32(i + 8),
			avgBitrate: view.getUint32(i + 12),
		});
	}

	return boxes;
};
