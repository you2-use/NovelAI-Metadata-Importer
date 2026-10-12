/* Local-only NovelAI PNG/WebP reader. No network, host storage, or provider credentials. */
const naiMetadata = (() => {
  const MAX_FILE = 32 * 1024 * 1024;
  const MAX_TEXT = 1024 * 1024;
  const MAX_PIXELS = 16 * 1024 * 1024;
  const fail = (code) => {
    throw new Error(code);
  };
  const record = (x) =>
    x !== null && typeof x === "object" && !Array.isArray(x);
  const ascii = (bytes) => new TextDecoder("latin1").decode(bytes);
  const utf8 = (bytes) =>
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const text = (bytes) => {
    try {
      return utf8(bytes);
    } catch {
      return ascii(bytes);
    }
  };
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc(bytes) {
    let value = 0xffffffff;
    for (const b of bytes) value = crcTable[(value ^ b) & 255] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  }
  async function inflate(bytes, format, limit) {
    if (typeof DecompressionStream !== "function")
      fail("compressionUnavailable");
    const reader = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream(format))
      .getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) {
          await reader.cancel();
          fail("tooLarge");
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error.message === "tooLarge") throw error;
      fail("damaged");
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
  function json(value) {
    try {
      const parsed = JSON.parse(value);
      if (record(parsed)) return parsed;
    } catch {
      /* handled below */
    }
    fail("damaged");
  }
  async function textChunk(type, bytes) {
    const separator = bytes.indexOf(0);
    if (separator < 1 || separator > 79) fail("damaged");
    const key = ascii(bytes.subarray(0, separator));
    if (
      !["Comment", "Description", "Software", "Source", "Model"].includes(key)
    )
      return null;
    let value = bytes.subarray(separator + 1);
    if (type === "zTXt") {
      if (value[0] !== 0) fail("damaged");
      value = await inflate(value.subarray(1), "deflate", MAX_TEXT);
    } else if (type === "iTXt") {
      const compressed = value[0];
      if ((compressed !== 0 && compressed !== 1) || value[1] !== 0)
        fail("damaged");
      value = value.subarray(2);
      for (let i = 0; i < 2; i++) {
        const end = value.indexOf(0);
        if (end < 0) fail("damaged");
        value = value.subarray(end + 1);
      }
      if (compressed) value = await inflate(value, "deflate", MAX_TEXT);
    }
    if (value.length > MAX_TEXT) fail("tooLarge");
    return [key, type === "iTXt" ? utf8(value) : text(value)];
  }
  const modelFamilies = Object.freeze({
    3: ["nai-diffusion-3"],
    4: ["nai-diffusion-4-curated-preview", "nai-diffusion-4-full"],
    4.5: ["nai-diffusion-4-5-curated", "nai-diffusion-4-5-full"],
    5: ["nai-diffusion-5-curated", "nai-diffusion-5-full"],
  });
  const supportedModels = new Set(Object.values(modelFamilies).flat());
  function readModel(metadata, comment) {
    const matches = [];
    let unsupportedId = false;
    for (const raw of [
      comment.model,
      comment.model_name,
      metadata.Model,
      metadata.Source,
      metadata.Software,
    ]) {
      if (typeof raw !== "string" || raw.length > 200) continue;
      const value = raw.trim().toLowerCase();
      if (supportedModels.has(value)) {
        matches.push([value]);
        continue;
      }
      const apiFamily = value.match(/^nai-diffusion-(4-5|3|4|5)$/);
      if (apiFamily) {
        matches.push(modelFamilies[apiFamily[1].replace("-", ".")]);
        continue;
      }
      if (value.startsWith("nai-diffusion-")) {
        unsupportedId = true;
        continue;
      }
      // Source hashes do not provide a verified Full/Curated mapping. Never guess
      // a variant from a hash, prompt, sampler, seed, or UC preset.
      const match = value.match(
        /^(?:novelai|nai)\s+diffusion\s+(?:anime\s+)?v?(3|4\.5|4|5)(?=\s|$)(.*)$/,
      );
      if (!match) continue;
      let options = modelFamilies[match[1]];
      if (/\bfull\b/.test(match[2]))
        options = options.filter((id) => id.endsWith("-full"));
      if (/\bcurated\b/.test(match[2]))
        options = options.filter((id) => id.includes("-curated"));
      matches.push(options);
    }
    if (!matches.length)
      return { status: "unavailable", options: [], exactId: null };
    if (unsupportedId)
      return { status: "conflict", options: [], exactId: null };
    const options = matches.reduce((left, right) =>
      left.filter((id) => right.includes(id)),
    );
    if (!options.length)
      return { status: "conflict", options: [], exactId: null };
    return {
      status: options.length === 1 ? "exact" : "ambiguous",
      options,
      exactId: options.length === 1 ? options[0] : null,
    };
  }
  function normalize(metadata) {
    if (!record(metadata)) fail("notFound");
    const comment =
      typeof metadata.Comment === "string"
        ? json(metadata.Comment)
        : metadata.Comment;
    const c = record(comment) ? comment : {};
    const modelImport = readModel(metadata, c);
    if (
      !/novelai/i.test(
        `${metadata.Software || ""} ${metadata.Source || ""} ${c.model_name || ""} ${c.model || ""} ${metadata.Model || ""}`,
      ) &&
      !record(c.v4_prompt) &&
      !modelImport.options.length
    )
      fail("notFound");
    const values = {};
    const omitted = [];
    for (const [key, source, min, max, integer] of [
      ["steps", "steps", 1, 150, true],
      ["promptGuidance", "scale", 0, 30, false],
      ["promptGuidanceRescale", "cfg_rescale", 0, 1, false],
    ]) {
      const value = c[source];
      if (value === undefined) continue;
      if (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max &&
        (!integer || Number.isInteger(value))
      )
        values[key] = value;
      else omitted.push(key);
    }
    for (const [key, value, max] of [
      [
        "promptPrefix",
        c.v4_prompt?.caption?.base_caption ?? c.prompt ?? metadata.Description,
        131072,
      ],
      [
        "negativePromptPrefix",
        c.v4_negative_prompt?.caption?.base_caption ??
          c.uc ??
          c.negative_prompt,
        131072,
      ],
      ["sampler", c.sampler, 200],
      ["noiseSchedule", c.noise_schedule, 200],
    ]) {
      if (value === undefined || value === null) continue;
      if (
        typeof value === "string" &&
        value.length <= max &&
        (!/^(sampler|noiseSchedule)$/.test(key) ||
          /^[a-zA-Z0-9_. -]+$/.test(value))
      )
        values[key] = value;
      else omitted.push(key);
    }
    if (modelImport.exactId) values.model = modelImport.exactId;
    if (!Object.keys(values).length && !modelImport.options.length)
      fail("notFound");
    // Deliberately never read c.seed, c.ucPreset, c.uc_preset, or c.tag_hint_uc_preset.
    return {
      values,
      omitted,
      modelImport,
      model: String(
        c.model ||
          c.model_name ||
          metadata.Model ||
          metadata.Source ||
          metadata.Software ||
          "NovelAI",
      ).slice(0, 200),
      width: Number.isInteger(c.width) && c.width > 0 ? c.width : null,
      height: Number.isInteger(c.height) && c.height > 0 ? c.height : null,
      characters: Array.isArray(c.v4_prompt?.caption?.char_captions)
        ? c.v4_prompt.caption.char_captions.length
        : 0,
    };
  }
  function paeth(a, b, c) {
    const p = a + b - c,
      da = Math.abs(p - a),
      db = Math.abs(p - b),
      dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  }
  async function readAlpha(header, idats) {
    const { width, height, depth, color, interlace } = header;
    if (color !== 6) fail("notFound");
    if (depth !== 8 || interlace !== 0) fail("alphaUnsupported");
    const compressed = new Uint8Array(
      idats.reduce((sum, x) => sum + x.length, 0),
    );
    let offset = 0;
    for (const chunk of idats) {
      compressed.set(chunk, offset);
      offset += chunk.length;
    }
    const stride = width * 4;
    const raw = await inflate(compressed, "deflate", (stride + 1) * height);
    if (raw.length !== (stride + 1) * height) fail("damaged");
    const alpha = new Uint8Array(width * height);
    let previous = new Uint8Array(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      if (filter > 4) fail("damaged");
      const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const a = x >= 4 ? row[x - 4] : 0,
          b = previous[x],
          c = x >= 4 ? previous[x - 4] : 0;
        const predictor =
          filter === 0
            ? 0
            : filter === 1
              ? a
              : filter === 2
                ? b
                : filter === 3
                  ? Math.floor((a + b) / 2)
                  : paeth(a, b, c);
        row[x] = (row[x] + predictor) & 255;
      }
      for (let x = 0; x < width; x++) alpha[y * width + x] = row[x * 4 + 3];
      previous = row;
    }
    let bit = 0;
    const take = (count) => {
      if (bit + count * 8 > alpha.length) fail("damaged");
      const out = new Uint8Array(count);
      for (let n = 0; n < count; n++)
        for (let k = 0; k < 8; k++, bit++)
          out[n] =
            (out[n] << 1) |
            (alpha[(bit % height) * width + Math.floor(bit / height)] & 1);
      return out;
    };
    if (alpha.length < 152 || ascii(take(15)) !== "stealth_pngcomp")
      fail("notFound");
    const lengthBytes = take(4);
    const length = new DataView(lengthBytes.buffer).getUint32(0);
    if (length % 8 !== 0 || length / 8 > MAX_TEXT) fail("tooLarge");
    return json(utf8(await inflate(take(length / 8), "gzip", MAX_TEXT)));
  }
  function readExif(bytes) {
    if (bytes.length > MAX_TEXT) fail("tooLarge");
    // WebP writers use both a bare TIFF header and the JPEG-style Exif prefix.
    if (ascii(bytes.subarray(0, 6)) === "Exif\0\0") bytes = bytes.subarray(6);
    if (bytes.length < 8) fail("damaged");
    const order = ascii(bytes.subarray(0, 2));
    if (order !== "II" && order !== "MM") fail("damaged");
    const little = order === "II";
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const span = (offset, length) => {
      if (offset < 8 || offset + length > bytes.length) fail("damaged");
    };
    if (view.getUint16(2, little) !== 42) fail("damaged");
    const tags = new Map();
    let exifOffset = null;
    function directory(offset, root) {
      span(offset, 2);
      const count = view.getUint16(offset, little);
      if (count > 256) fail("tooLarge");
      span(offset, 2 + count * 12 + 4);
      for (let i = 0; i < count; i++) {
        const pos = offset + 2 + i * 12;
        const tag = view.getUint16(pos, little);
        const type = view.getUint16(pos + 2, little);
        const length = view.getUint32(pos + 4, little);
        if (root && tag === 0x8769) {
          if (type !== 4 || length !== 1) fail("damaged");
          const target = view.getUint32(pos + 8, little);
          if (exifOffset !== null && exifOffset !== target) fail("conflict");
          exifOffset = target;
        } else if ([0x010e, 0x0131, 0x9286].includes(tag)) {
          if (![1, 2, 7].includes(type)) fail("damaged");
          if (length > MAX_TEXT) fail("tooLarge");
          const start = length <= 4 ? pos + 8 : view.getUint32(pos + 8, little);
          span(start, length);
          const value = bytes.subarray(start, start + length);
          const previous = tags.get(tag);
          if (
            previous &&
            (previous.length !== length ||
              previous.some((byte, index) => byte !== value[index]))
          )
            fail("conflict");
          tags.set(tag, value);
        }
      }
    }
    const rootOffset = view.getUint32(4, little);
    directory(rootOffset, true);
    if (exifOffset !== null) {
      if (exifOffset === rootOffset) fail("damaged");
      directory(exifOffset, false);
    }
    const clean = (value) => value.replace(/\0+$/, "");
    const metadata = Object.create(null);
    if (tags.has(0x010e)) metadata.Description = clean(text(tags.get(0x010e)));
    if (tags.has(0x0131)) {
      // NovelAI stores the Source/model description in EXIF Software.
      metadata.Source = clean(text(tags.get(0x0131)));
      metadata.Software = metadata.Source;
    }
    if (tags.has(0x9286)) {
      let value = tags.get(0x9286);
      const encoding = ascii(value.subarray(0, 8));
      let comment;
      if (encoding === "UNICODE\0") {
        value = value.subarray(8);
        const bomLE = value[0] === 0xff && value[1] === 0xfe;
        const bomBE = value[0] === 0xfe && value[1] === 0xff;
        const useLE = bomLE || (!bomBE && little);
        if (bomLE || bomBE) value = value.subarray(2);
        if (value.length % 2) fail("damaged");
        try {
          comment = new TextDecoder(useLE ? "utf-16le" : "utf-16be", {
            fatal: true,
          }).decode(value);
        } catch {
          fail("damaged");
        }
      } else {
        if (encoding === "ASCII\0\0\0" || encoding === "\0".repeat(8))
          value = value.subarray(8);
        comment = text(value);
      }
      const parsed = json(clean(comment));
      // Converters may preserve the PNG metadata object or only its Comment JSON.
      if (Object.hasOwn(parsed, "Comment")) {
        for (const key of [
          "Comment",
          "Description",
          "Software",
          "Source",
          "Model",
        ])
          if (Object.hasOwn(parsed, key)) metadata[key] = parsed[key];
      } else metadata.Comment = parsed;
    }
    return metadata;
  }
  function readWebp(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) + 8 !== bytes.length) fail("damaged");
    let dimensions = null,
      image = false,
      exif = null;
    const size = (width, height) => {
      if (!width || !height) fail("damaged");
      if (width * height > MAX_PIXELS) fail("tooLarge");
      if (
        dimensions &&
        (width !== dimensions.width || height !== dimensions.height)
      )
        fail("damaged");
      dimensions = { width, height };
    };
    for (let pos = 12; pos < bytes.length;) {
      if (pos + 8 > bytes.length) fail("damaged");
      const length = view.getUint32(pos + 4, true);
      const end = pos + 8 + length;
      const next = end + (length % 2);
      if (next > bytes.length || (length % 2 && bytes[end] !== 0))
        fail("damaged");
      const type = ascii(bytes.subarray(pos, pos + 4));
      const data = bytes.subarray(pos + 8, end);
      if (type === "VP8X") {
        if (pos !== 12 || length !== 10) fail("damaged");
        if (data[0] & 2) fail("webpAnimationUnsupported");
        const u24 = (i) => data[i] | (data[i + 1] << 8) | (data[i + 2] << 16);
        size(1 + u24(4), 1 + u24(7));
      } else if (type === "VP8L" || type === "VP8 ") {
        if (image) fail("damaged");
        image = true;
        if (type === "VP8L") {
          if (length < 5 || data[0] !== 0x2f) fail("damaged");
          const bits = view.getUint32(pos + 9, true);
          if (bits >>> 29) fail("damaged");
          size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
        } else {
          if (
            length < 10 ||
            data[0] & 1 ||
            data[3] !== 0x9d ||
            data[4] !== 1 ||
            data[5] !== 0x2a
          )
            fail("damaged");
          size(
            view.getUint16(pos + 14, true) & 0x3fff,
            view.getUint16(pos + 16, true) & 0x3fff,
          );
        }
      } else if (type === "ANIM" || type === "ANMF")
        fail("webpAnimationUnsupported");
      else if (type === "EXIF") {
        if (length > MAX_TEXT) fail("tooLarge");
        if (
          exif &&
          (exif.length !== length || exif.some((byte, i) => byte !== data[i]))
        )
          fail("conflict");
        exif = data;
      }
      pos = next;
    }
    if (!image || !dimensions) fail("damaged");
    if (!exif) fail("notFound");
    return { ...normalize(readExif(exif)), source: "WebP EXIF" };
  }
  async function readPng(bytes) {
    if (bytes.length < 33) fail("damaged");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const metadata = Object.create(null),
      idats = [];
    let header,
      ended = false,
      textSize = 0;
    for (let pos = 8; pos < bytes.length;) {
      if (pos + 12 > bytes.length) fail("damaged");
      const size = view.getUint32(pos),
        end = pos + 12 + size;
      if (end > bytes.length) fail("damaged");
      const type = ascii(bytes.subarray(pos + 4, pos + 8));
      const data = bytes.subarray(pos + 8, pos + 8 + size);
      if (
        crc(bytes.subarray(pos + 4, pos + 8 + size)) !==
        view.getUint32(pos + 8 + size)
      )
        fail("damaged");
      if (!header && type !== "IHDR") fail("damaged");
      if (type === "IHDR") {
        if (header || size !== 13) fail("damaged");
        header = {
          width: view.getUint32(pos + 8),
          height: view.getUint32(pos + 12),
          depth: data[8],
          color: data[9],
          interlace: data[12],
        };
        if (
          !header.width ||
          !header.height ||
          header.width * header.height > MAX_PIXELS
        )
          fail("tooLarge");
        if (data[10] !== 0 || data[11] !== 0) fail("damaged");
      } else if (["tEXt", "zTXt", "iTXt"].includes(type)) {
        const entry = await textChunk(type, data);
        if (entry) {
          textSize += entry[1].length;
          if (textSize > MAX_TEXT) fail("tooLarge");
          if (
            metadata[entry[0]] !== undefined &&
            metadata[entry[0]] !== entry[1]
          )
            fail("conflict");
          metadata[entry[0]] = entry[1];
        }
      } else if (type === "IDAT") idats.push(data);
      else if (type === "IEND") {
        if (size !== 0) fail("damaged");
        ended = true;
        break;
      }
      pos = end;
    }
    if (!ended || !idats.length) fail("damaged");
    if (metadata.Comment !== undefined)
      return { ...normalize(metadata), source: "PNG" };
    try {
      return { ...normalize(await readAlpha(header, idats)), source: "Alpha" };
    } catch (error) {
      if (error.message !== "notFound") throw error;
      return { ...normalize(metadata), source: "PNG" };
    }
  }
  async function read(file) {
    if (!file || file.size > MAX_FILE) fail("tooLarge");
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_FILE) fail("tooLarge");
    if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
      return readPng(bytes);
    if (
      bytes.length >= 12 &&
      ascii(bytes.subarray(0, 4)) === "RIFF" &&
      ascii(bytes.subarray(8, 12)) === "WEBP"
    )
      return readWebp(bytes);
    fail("notImage");
  }
  return Object.freeze({ read, normalize });
})();


/* Marinara Engine 2.5.0 full-page extension. All DOM changes are scoped and cleaned up. */
(() => {
  const messages = {
    ko: {
      import: "가져오기",
      title: "NovelAI 이미지 설정 가져오기",
      choose: "PNG 또는 WebP 이미지 선택",
      drop: "이미지를 놓거나 파일을 선택하세요",
      local: "이미지는 이 브라우저에서만 분석합니다.",
      apply: "적용",
      thumbnail: "이미지를 썸네일로 등록하기",
      thumbnailHint:
        "적용하면 연결 사진을 바로 저장합니다. 기존 사진이 있으면 교체합니다.",
      thumbnailUnavailable:
        "현재 연결을 확인할 수 없습니다. 고유한 이름으로 저장한 뒤 연결 목록에서 다시 선택하세요. 서버 연결 상태도 확인하세요.",
      thumbnailApplied:
        "썸네일을 등록했습니다. 변경한 생성 설정은 Marinara의 저장 버튼으로 저장하세요.",
      thumbnailFailed:
        "생성 설정은 반영했지만 썸네일 등록에 실패했습니다. 설정을 저장한 뒤 다시 시도하세요.",
      cancel: "취소",
      reading: "메타데이터를 읽는 중…",
      select: "적용",
      field: "항목",
      current: "현재 설정",
      incoming: "가져올 설정",
      empty: "(비어 있음)",
      steps: "단계",
      promptGuidance: "프롬프트 가이던스",
      promptGuidanceRescale: "가이던스 리스케일",
      promptPrefix: "프롬프트 접두사",
      negativePromptPrefix: "네거티브 접두사",
      sampler: "샘플러",
      noiseSchedule: "노이즈 스케줄",
      model: "모델",
      sourceModel: "원본 모델: {model}",
      chooseModel: "가져올 모델 선택",
      ambiguousModel:
        "모델 버전은 확인했지만 Full·Curated 구분은 없습니다. 모델을 가져오려면 아래에서 선택하세요.",
      unavailableModel:
        "이미지에서 지원되는 모델을 확인하지 못해 현재 모델을 유지합니다.",
      conflictingModel:
        "이미지의 모델 정보가 서로 달라 현재 모델을 유지합니다.",
      characters:
        "캐릭터별 프롬프트 {count}개는 제외합니다. 기본 프롬프트만 가져옵니다.",
      prefix:
        "접두사는 새 장면의 프롬프트 앞에 추가됩니다. 원본 이미지의 완전한 재현 기능은 아닙니다.",
      omitted: "지원 범위를 벗어난 항목 제외: {fields}",
      size: "원본 크기: {width} × {height}",
      applied: "설정에 반영했습니다. Marinara의 저장 버튼을 눌러 저장하세요.",
      applying: "설정을 반영하는 중…",
      notImage:
        "PNG 또는 WebP 파일을 선택하세요. 확장자만 변경한 파일은 지원하지 않습니다.",
      notFound:
        "NovelAI 생성 메타데이터를 찾지 못했습니다. 정보가 보존된 원본 PNG 또는 WebP를 사용하세요.",
      damaged: "이미지 또는 메타데이터가 손상되어 읽을 수 없습니다.",
      tooLarge:
        "파일 또는 데이터가 너무 큽니다. PNG·WebP 32 MB, 16메가픽셀까지 지원합니다.",
      webpAnimationUnsupported:
        "움직이는 WebP는 지원하지 않습니다. 정지 PNG 또는 WebP를 선택하세요.",
      conflict:
        "서로 다른 메타데이터가 중복되어 있습니다. 이 이미지는 자동 적용할 수 없습니다.",
      compressionUnavailable:
        "이 브라우저는 압축 메타데이터 읽기를 지원하지 않습니다. 최신 Safari 또는 Chrome을 사용하세요.",
      alphaUnsupported:
        "숨겨진 메타데이터는 8비트 RGBA, 비인터레이스 PNG에서 지원합니다.",
      changed:
        "연결 또는 설정 화면이 변경되었습니다. 현재 연결에서 가져오기를 다시 열어주세요.",
      incompatible:
        "설정 입력 칸을 정확히 찾지 못했습니다. Marinara v2.5.0의 NovelAI 연결인지 확인하세요.",
      applyFailed:
        "설정 반영에 실패했습니다. 변경된 값이 있는지 확인한 뒤 다시 시도하세요.",
      rolledBack: "설정 반영에 실패해 이전 값으로 되돌렸습니다.",
    },
    en: {
      import: "Import",
      title: "Import NovelAI image settings",
      choose: "Choose PNG or WebP image",
      drop: "Drop an image here or choose a file",
      local: "Images are processed only in this browser.",
      apply: "Apply",
      thumbnail: "Use image as connection thumbnail",
      thumbnailHint:
        "Applying saves the connection picture immediately, replacing any existing picture.",
      thumbnailUnavailable:
        "Cannot verify the current connection. Save a unique name, select it again from the connection list, and check your server connection.",
      thumbnailApplied:
        "Thumbnail saved. Use Marinara's Save button to save any changed generation settings.",
      thumbnailFailed:
        "Generation settings were applied, but the thumbnail could not be saved. Save the settings, then try again.",
      cancel: "Cancel",
      reading: "Reading metadata…",
      select: "Apply",
      field: "Setting",
      current: "Current",
      incoming: "From image",
      empty: "(empty)",
      steps: "Steps",
      promptGuidance: "Prompt Guidance",
      promptGuidanceRescale: "Guidance Rescale",
      promptPrefix: "Prompt Prefix",
      negativePromptPrefix: "Negative Prefix",
      sampler: "Sampler",
      noiseSchedule: "Noise Schedule",
      model: "Model",
      sourceModel: "Source model: {model}",
      chooseModel: "Choose model to import",
      ambiguousModel:
        "The model version is known, but Full/Curated is missing. Choose a variant below to import the model.",
      unavailableModel:
        "No supported model was identified in the image. The current model will be kept.",
      conflictingModel:
        "The image has conflicting model information. The current model will be kept.",
      characters:
        "Excluded {count} character prompt(s). Only the base prompt is imported.",
      prefix:
        "Prefixes are added before new scene prompts. This does not fully reproduce the original image.",
      omitted: "Excluded unsupported values: {fields}",
      size: "Source size: {width} × {height}",
      applied:
        "Settings applied. Use Marinara's Save button to save this connection.",
      applying: "Applying settings…",
      notImage:
        "Choose a PNG or WebP file. Renaming another format is not supported.",
      notFound:
        "No NovelAI generation metadata found. Use a PNG or WebP with its original metadata preserved.",
      damaged: "The image or its metadata is damaged and could not be read.",
      tooLarge:
        "The file or data is too large. Supports PNG/WebP up to 32 MB and 16 megapixels.",
      webpAnimationUnsupported:
        "Animated WebP is not supported. Choose a still PNG or WebP image.",
      conflict:
        "Conflicting duplicate metadata found. This image cannot be applied automatically.",
      compressionUnavailable:
        "This browser cannot read compressed metadata. Use a current Safari or Chrome.",
      alphaUnsupported:
        "Hidden metadata requires an 8-bit RGBA, non-interlaced PNG.",
      changed:
        "The connection or editor changed. Open Import again in the current connection.",
      incompatible:
        "Could not uniquely identify the fields. Check that this is a Marinara v2.5.0 NovelAI connection.",
      applyFailed:
        "Could not apply all settings. Check the connection values before trying again.",
      rolledBack:
        "Could not apply settings. Previous values have been restored.",
    },
  };
  let stopped = false,
    scanning = false,
    dialog = null,
    revision = 0,
    busy = false;
  const hosts = new Map();
  const thumbnails = new Map();
  const requests = new Set();
  // The mobile shell unmounts the list when a connection is opened.
  // Capture its ID before React handles the click; restored editors use UI state.
  function storedConnectionId() {
    try {
      const id = JSON.parse(localStorage.getItem("marinara-engine-ui"))?.state
        ?.connectionDetailId;
      return typeof id === "string" && id ? id : null;
    } catch {
      return null;
    }
  }
  let selectedConnectionId = storedConnectionId();
  const editedNames = new WeakMap();
  function rememberNameEdit(event) {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) ||
      !target.matches(
        ".mari-editor-title-input, .mari-editor-content-inner > .mari-editor-panel:first-child > input",
      )
    )
      return;
    const title = target.matches(".mari-editor-title-input")
      ? target
      : target
          .closest(".mari-editor-shell")
          ?.querySelector(".mari-editor-title-input");
    if (title) editedNames.set(title, target.value);
  }
  function rememberConnection(event) {
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, input, select"))
      return;
    const row = target.closest("[data-connection-id]");
    if (row) selectedConnectionId = row.dataset.connectionId || null;
  }
  document.addEventListener("click", rememberConnection, true);
  document.addEventListener("input", rememberNameEdit, true);
  async function savedConnectionMatches(identity, resolveNewEditor = false) {
    if (!identity.connectionId && !resolveNewEditor) return false;
    const controller = new AbortController();
    requests.add(controller);
    const timeout = marinara.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await marinara.fetch("/api/connections", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const connections = await response.json();
      if (!Array.isArray(connections)) return false;
      const matches = connections.filter(
        (entry) => entry?.name === identity.name,
      );
      if (
        matches.length !== 1 ||
        typeof matches[0].id !== "string" ||
        !matches[0].id
      )
        return false;
      if (matches[0].id !== identity.connectionId) {
        // Creation/duplication opens an editor without selecting a list row.
        // A typed name must never redirect an existing editor to another ID.
        if (
          !resolveNewEditor ||
          editedNames.get(identity.title) === identity.name
        )
          return false;
        if (storedConnectionId() !== matches[0].id) {
          // ponytail: v2.5.0 debounces UI storage for 1s. Retry one read, then fail closed;
          // replace this bounded fallback with a public current-editor ID API when available.
          await new Promise((resolve) => {
            const finish = () => {
              marinara.clearTimeout(timer);
              controller.signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = marinara.setTimeout(finish, 1100);
            controller.signal.addEventListener("abort", finish, { once: true });
            if (controller.signal.aborted) finish();
          });
        }
        if (controller.signal.aborted || storedConnectionId() !== matches[0].id)
          return false;
        unchanged(identity.header, identity);
        selectedConnectionId = identity.connectionId = matches[0].id;
      }
      identity.previousImagePath =
        typeof matches[0].imagePath === "string" ? matches[0].imagePath : null;
      return true;
    } catch {
      return false;
    } finally {
      marinara.clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  function showThumbnails() {
    if (!thumbnails.size) return;
    for (const row of document.querySelectorAll("[data-connection-id]")) {
      const pending = thumbnails.get(row.dataset.connectionId);
      if (!pending) continue;
      const { path, previous } = pending;
      const tile = row.querySelector(":scope > button > span.relative");
      if (!tile) continue;
      const original = tile.querySelector("img:not(.nai-mi-connection-image)");
      const overlay = tile.querySelector(".nai-mi-connection-image");
      const current = original?.getAttribute("src") || null;
      if (current === path || current !== previous) {
        overlay?.remove();
        thumbnails.delete(row.dataset.connectionId);
      } else if (overlay) {
        if (overlay.getAttribute("src") !== path) overlay.src = path;
      } else {
        const image = node("img", "nai-mi-connection-image");
        image.src = path;
        image.alt = "";
        image.draggable = false;
        tile.insertBefore(image, tile.lastElementChild);
      }
    }
  }
  async function saveThumbnail(header, identity, preview) {
    unchanged(header, identity);
    if (!(await savedConnectionMatches(identity))) throw new Error("changed");
    unchanged(header, identity);
    await preview.decode();
    const canvas = document.createElement("canvas");
    const scale = Math.min(
      1,
      512 / Math.max(preview.naturalWidth, preview.naturalHeight),
    );
    canvas.width = Math.max(1, Math.round(preview.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(preview.naturalHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("applyFailed");
    context.fillStyle =
      getComputedStyle(document.documentElement)
        .getPropertyValue("--muted")
        .trim() || "rgb(240 238 244)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(preview, 0, 0, canvas.width, canvas.height);
    // Re-encoding drops text/EXIF; opaque pixels also drop alpha-channel metadata.
    const image = canvas.toDataURL("image/png");
    unchanged(header, identity);
    const controller = new AbortController();
    requests.add(controller);
    const timeout = marinara.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await marinara.fetch(
        `/api/connections/${encodeURIComponent(identity.connectionId)}/image`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Marinara-CSRF": "1",
          },
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
          body: JSON.stringify({ image }),
        },
      );
      if (!response.ok) throw new Error("applyFailed");
      const saved = await response.json();
      if (
        saved.id !== identity.connectionId ||
        typeof saved.imagePath !== "string" ||
        !/^\/api\/connections\/images\/file\/[a-zA-Z0-9_.-]+$/.test(
          saved.imagePath,
        )
      )
        throw new Error("applyFailed");
      if (!stopped) {
        const row = Array.from(
          document.querySelectorAll("[data-connection-id]"),
        ).find((row) => row.dataset.connectionId === identity.connectionId);
        // A mobile list can return from its five-minute cache after upload.
        const previous = row
          ? row
              .querySelector("img:not(.nai-mi-connection-image)")
              ?.getAttribute("src") || null
          : thumbnails.has(identity.connectionId)
            ? thumbnails.get(identity.connectionId).previous
            : identity.previousImagePath;
        thumbnails.set(identity.connectionId, {
          path: saved.imagePath,
          previous,
        });
        // Avoid refetching the editor: v2.5.0 hydration clears unsaved form values.
        showThumbnails();
      }
    } finally {
      marinara.clearTimeout(timeout);
      requests.delete(controller);
    }
  }
  const language = () =>
    document.documentElement.lang.toLowerCase().startsWith("ko") ? "ko" : "en";
  function t(key, args = {}) {
    return (
      messages[language()][key] ||
      messages.en[key] ||
      messages[language()].damaged
    ).replace(/\{(\w+)\}/g, (_, name) => String(args[name] ?? ""));
  }
  function node(tag, className, content) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (content !== undefined) el.textContent = content;
    return el;
  }
  const frame = () =>
    new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  function modelInput(header) {
    const editor = header.closest(".mari-editor-shell");
    const inputs = Array.from(
      editor?.querySelectorAll(".mari-editor-panel") || [],
    )
      .filter((panel) =>
        panel.querySelector(":scope > div.relative > div.cursor-pointer"),
      )
      .flatMap((panel) =>
        Array.from(panel.querySelectorAll(":scope > div.mt-2 > input")),
      );
    if (inputs.length !== 1) throw new Error("incompatible");
    return inputs[0];
  }
  function identify(header) {
    const editor = header.closest(".mari-editor-shell");
    const title = editor?.querySelector(".mari-editor-title-input");
    const model = modelInput(header);
    if (!editor || !title) throw new Error("incompatible");
    return {
      header,
      editor,
      title,
      name: title.value,
      modelName: model.value,
      connectionId: selectedConnectionId,
    };
  }
  function unchanged(header, identity) {
    if (
      stopped ||
      !header.isConnected ||
      !identity.editor.isConnected ||
      identity.title.value !== identity.name ||
      modelInput(header).value !== identity.modelName ||
      (identity.connectionId && selectedConnectionId !== identity.connectionId)
    )
      throw new Error("changed");
  }
  function fields(header) {
    const panel = header.parentElement;
    const seeds = panel.querySelectorAll(
      'input[type="number"][min="-1"][max="4294967295"]',
    );
    if (seeds.length !== 1) throw new Error("incompatible");
    const numericGroup = seeds[0].closest(".grid");
    if (!numericGroup || !panel.contains(numericGroup))
      throw new Error("incompatible");
    const one = (selector) => {
      const found = numericGroup.querySelectorAll(selector);
      if (found.length !== 1) throw new Error("incompatible");
      return found[0];
    };
    const textareas = Array.from(panel.querySelectorAll("label > textarea"));
    const choices = Array.from(panel.querySelectorAll("label > input[list]"));
    if (textareas.length !== 2 || choices.length !== 2)
      throw new Error("incompatible");
    return {
      model: modelInput(header),
      seed: one('input[type="number"][min="-1"][max="4294967295"]'),
      steps: one('input[type="number"][min="1"][max="150"]'),
      promptGuidance: one('input[type="number"][min="0"][max="30"]'),
      promptGuidanceRescale: one('input[type="number"][min="0"][max="1"]'),
      undesiredContentPreset: one('input[type="number"][min="0"][max="4"]'),
      promptPrefix: textareas[0],
      negativePromptPrefix: textareas[1],
      sampler: choices[0],
      noiseSchedule: choices[1],
    };
  }
  async function commit(header, identity, key, value) {
    unchanged(header, identity);
    const el = fields(header)[key];
    el.focus({ preventScroll: true });
    const prototype =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(
      el,
      String(value),
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    const expected =
      key === "model" ? { ...identity, modelName: String(value) } : identity;
    unchanged(header, expected);
    el.blur();
    await frame();
    unchanged(header, expected);
    if (fields(header)[key].value !== String(value))
      throw new Error("applyFailed");
    if (key === "model") identity.modelName = String(value);
  }
  function dismiss() {
    revision++;
    for (const controller of requests) controller.abort();
    if (dialog) {
      dialog.close();
      dialog.remove();
      dialog = null;
    }
  }
  async function open(header, state) {
    if (busy || stopped) return;
    dismiss();
    const thisRevision = revision;
    state.status.textContent = "";
    let identity, controls;
    try {
      identity = identify(header);
      if (
        !header.parentElement.querySelector('input[type="number"][min="-1"]')
      ) {
        header.click();
        await frame();
      }
      if (stopped || revision !== thisRevision) return;
      unchanged(header, identity);
      controls = fields(header);
    } catch (error) {
      state.status.textContent = t(error.message);
      return;
    }
    const win = node("dialog", "nai-mi-dialog");
    dialog = win;
    const heading = node("h2", "", t("title"));
    heading.id = "nai-mi-heading";
    win.setAttribute("aria-labelledby", heading.id);
    const body = node("div", "nai-mi-body");
    body.append(heading, node("p", "nai-mi-muted", t("local")));
    const drop = node("label", "nai-mi-drop");
    const file = node("input", "nai-mi-file");
    file.type = "file";
    file.accept = ".png,.webp,image/png,image/webp";
    file.setAttribute("aria-label", t("choose"));
    drop.append(node("span", "", t("drop")), file);
    const info = node("div", "nai-mi-info");
    const status = node("p", "nai-mi-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    body.append(drop, status, info);
    const footer = node("div", "nai-mi-footer");
    const thumbnailOption = node("label", "nai-mi-thumbnail-option");
    const thumbnail = node("input", "nai-mi-thumbnail-toggle");
    thumbnail.type = "checkbox";
    thumbnail.setAttribute("role", "switch");
    thumbnail.setAttribute("aria-label", t("thumbnail"));
    thumbnail.disabled = true;
    const thumbnailText = node("span", "");
    const thumbnailHint = node(
      "span",
      "nai-mi-muted",
      t(identity.connectionId ? "thumbnailHint" : "thumbnailUnavailable"),
    );
    thumbnailHint.id = "nai-mi-thumbnail-hint";
    thumbnail.setAttribute("aria-describedby", thumbnailHint.id);
    thumbnailText.append(node("span", "", t("thumbnail")), thumbnailHint);
    thumbnailOption.append(thumbnail, thumbnailText);
    body.append(thumbnailOption);
    const cancel = node("button", "nai-mi-button", t("cancel"));
    cancel.type = "button";
    const apply = node("button", "nai-mi-button nai-mi-primary", t("apply"));
    apply.type = "button";
    apply.disabled = true;
    footer.append(cancel, apply);
    win.append(body, footer);
    document.body.append(win);
    let parsed = null,
      selections = [],
      objectUrl = null,
      imagePreview = null,
      loadNumber = 0;
    const enable = () => {
      apply.disabled =
        !parsed ||
        !(thumbnail.checked || selections.some(({ check }) => check.checked));
    };
    thumbnail.addEventListener("change", enable);
    const release = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };
    const close = () => {
      release();
      dismiss();
      state.button.focus({ preventScroll: true });
    };
    cancel.addEventListener("click", close);
    win.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    win.addEventListener("close", release, { once: true });
    win.addEventListener("click", (event) => event.stopPropagation());
    win.addEventListener("keydown", (event) => event.stopPropagation());
    win.showModal();
    async function load(image) {
      if (!image || busy) return;
      const currentLoad = ++loadNumber;
      for (const controller of requests) controller.abort();
      parsed = null;
      imagePreview = null;
      thumbnail.checked = false;
      thumbnail.disabled = true;
      apply.disabled = true;
      selections = [];
      info.replaceChildren();
      release();
      status.textContent = t("reading");
      try {
        const result = await naiMetadata.read(image);
        if (stopped || revision !== thisRevision || loadNumber !== currentLoad)
          return;
        unchanged(header, identity);
        // Verify in parallel with rendering so metadata-only importing stays local.
        const thumbnailVerification = savedConnectionMatches(identity, true);
        controls = fields(header);
        const incoming = { ...result.values };
        if (!incoming.model && result.modelImport.options.length)
          incoming.model = "";
        // The dialog owns this draft so choosing a variant never changes the form.
        parsed = { ...result, values: incoming };
        status.textContent = "";
        delete status.dataset.error;
        const summary = node("div", "nai-mi-summary");
        const preview = node("img", "nai-mi-preview");
        objectUrl = URL.createObjectURL(image);
        preview.src = objectUrl;
        imagePreview = preview;
        preview.alt = image.name;
        const details = node("div", "");
        details.append(
          node("p", "", image.name),
          node("p", "nai-mi-muted", t("sourceModel", { model: result.model })),
        );
        if (result.width && result.height)
          details.append(node("p", "nai-mi-muted", t("size", result)));
        summary.append(preview, details);
        info.append(summary);
        const modelNotice = {
          ambiguous: "ambiguousModel",
          unavailable: "unavailableModel",
          conflict: "conflictingModel",
        }[result.modelImport.status];
        if (modelNotice) info.append(node("p", "nai-mi-note", t(modelNotice)));
        if (result.characters)
          info.append(
            node(
              "p",
              "nai-mi-note",
              t("characters", { count: result.characters }),
            ),
          );
        info.append(node("p", "nai-mi-muted", t("prefix")));
        if (result.omitted.length)
          info.append(
            node(
              "p",
              "nai-mi-note",
              t("omitted", {
                fields: result.omitted.map((key) => t(key)).join(", "),
              }),
            ),
          );
        const table = node("table", "nai-mi-table");
        const thead = node("thead", "");
        const headRow = node("tr", "");
        for (const key of ["select", "field", "current", "incoming"]) {
          const th = node("th", "", t(key));
          th.scope = "col";
          headRow.append(th);
        }
        thead.append(headRow);
        const tbody = node("tbody", "");
        const ordered = Object.entries(incoming).sort(([a], [b]) =>
          a === "model" ? -1 : b === "model" ? 1 : 0,
        );
        for (const [key, value] of ordered) {
          const row = node("tr", "");
          const checkCell = node("td", "");
          const check = node("input", "");
          check.type = "checkbox";
          check.checked = key !== "model" || !!value;
          check.disabled = key === "model" && !value;
          check.setAttribute("aria-label", `${t("select")} ${t(key)}`);
          check.dataset.naiField = key;
          const heading = node("th", "", t(key));
          heading.scope = "row";
          checkCell.append(check);
          row.append(checkCell, heading);
          for (const item of [controls[key].value, String(value)]) {
            const cell = node("td", "");
            cell.dataset.label =
              row.children.length === 2 ? t("current") : t("incoming");
            if (key === "model" && row.children.length === 3) {
              const select = node("select", "nai-mi-model-select");
              select.setAttribute("aria-label", t("chooseModel"));
              const placeholder = node("option", "", t("chooseModel"));
              placeholder.value = "";
              select.append(placeholder);
              for (const id of result.modelImport.options) {
                const option = node("option", "", id);
                option.value = id;
                select.append(option);
              }
              select.value = value;
              select.addEventListener("change", () => {
                incoming.model = select.value;
                check.disabled = !select.value;
                check.checked = !!select.value;
                enable();
              });
              cell.append(select);
            } else if (key.endsWith("Prefix")) {
              const area = node("textarea", "");
              area.readOnly = true;
              area.value = item;
              area.rows = 4;
              area.setAttribute(
                "aria-label",
                `${t(key)} ${row.children.length === 2 ? t("current") : t("incoming")}`,
              );
              cell.append(area);
            } else cell.textContent = item || t("empty");
            row.append(cell);
          }
          selections.push({ key, check });
          tbody.append(row);
        }
        table.append(thead, tbody);
        const scroll = node("div", "nai-mi-table-scroll");
        scroll.append(table);
        info.append(scroll);
        selections.forEach(({ check }) =>
          check.addEventListener("change", enable),
        );
        enable();
        const canRegisterThumbnail = await thumbnailVerification;
        if (stopped || revision !== thisRevision || loadNumber !== currentLoad)
          return;
        unchanged(header, identity);
        thumbnail.disabled = !canRegisterThumbnail;
        thumbnailHint.textContent = t(
          canRegisterThumbnail ? "thumbnailHint" : "thumbnailUnavailable",
        );
      } catch (error) {
        if (revision === thisRevision && loadNumber === currentLoad) {
          status.textContent = t(error.message);
          status.dataset.error = "true";
        }
      }
    }
    file.addEventListener("change", () => load(file.files?.[0]));
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    drop.addEventListener("drop", (event) => {
      event.preventDefault();
      load(event.dataTransfer?.files[0]);
    });
    apply.addEventListener("click", async () => {
      if (
        !parsed ||
        busy ||
        !(thumbnail.checked || selections.some(({ check }) => check.checked))
      )
        return;
      const patch = Object.fromEntries(
        selections
          .filter(({ check }) => check.checked)
          .map(({ key }) => [key, parsed.values[key]]),
      );
      // Defaults are constants; neither is copied from image metadata.
      if (Object.keys(patch).length) {
        patch.seed = -1;
        patch.undesiredContentPreset = 0;
      }
      const registerThumbnail = thumbnail.checked;
      let snapshot = null;
      try {
        unchanged(header, identity);
        snapshot = Object.fromEntries(
          Object.entries(fields(header))
            .filter(([key]) => key in patch)
            .map(([key, el]) => [key, el.value]),
        );
        busy = true;
        apply.disabled = true;
        file.disabled = true;
        // Keep the preview URL alive until optional thumbnail encoding finishes.
        win.removeEventListener("close", release);
        dismiss();
        state.status.textContent = t("applying");
        const ordered = Object.entries(patch).sort(([a], [b]) =>
          a === "model" ? 1 : b === "model" ? -1 : 0,
        );
        for (const [key, value] of ordered)
          await commit(header, identity, key, value);
        state.status.textContent = t("applied");
        if (registerThumbnail) {
          try {
            await saveThumbnail(header, identity, imagePreview);
            state.status.textContent = t("thumbnailApplied");
          } catch {
            state.status.textContent = t("thumbnailFailed");
          }
        }
      } catch (error) {
        let restored = false;
        if (snapshot && !stopped) {
          try {
            for (const [key, value] of Object.entries(snapshot))
              await commit(header, identity, key, value);
            restored = true;
          } catch {
            /* Report partial application honestly. */
          }
        }
        state.status.textContent = restored
          ? t("rolledBack")
          : t(error.message === "changed" ? "changed" : "applyFailed");
      } finally {
        release();
        busy = false;
        if (state.button.isConnected)
          state.button.focus({ preventScroll: true });
      }
    });
  }
  function scan() {
    if (stopped) return;
    showThumbnails();
    for (const [header, state] of hosts)
      if (!header.isConnected || !state.button.isConnected) {
        state.button.remove();
        state.status.remove();
        state.parent.removeAttribute("data-nai-import-host");
        hosts.delete(header);
      }
    for (const header of document.querySelectorAll(
      ".mari-editor-shell button",
    )) {
      const title = header.firstElementChild?.firstElementChild;
      if (
        !title ||
        !/^NovelAI(?:\s|$)/i.test(title.textContent.trim()) ||
        header.nextElementSibling?.matches("[data-nai-import-open]")
      )
        continue;
      if (
        header.parentElement.firstElementChild !== header ||
        !header.querySelector("svg")
      )
        continue;
      if (hosts.has(header)) continue;
      const parent = header.parentElement;
      parent.setAttribute("data-nai-import-host", "");
      const button = node("button", "nai-mi-open");
      const icon = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "svg",
      );
      for (const [name, value] of Object.entries({
        viewBox: "0 0 24 24",
        width: "18",
        height: "18",
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "2",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false",
      }))
        icon.setAttribute(name, value);
      const path = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "path",
      );
      path.setAttribute(
        "d",
        "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3",
      );
      icon.append(path);
      button.append(icon);
      button.type = "button";
      button.dataset.naiImportOpen = "";
      button.setAttribute("aria-haspopup", "dialog");
      const status = node("p", "nai-mi-host-status");
      status.setAttribute("role", "status");
      const state = { parent, button, status };
      hosts.set(header, state);
      button.addEventListener("click", () => open(header, state));
      header.after(button);
      parent.append(status);
    }
    const label = t("import");
    for (const { button } of hosts.values()) {
      if (button.title !== label) button.title = label;
      if (button.getAttribute("aria-label") !== label)
        button.setAttribute("aria-label", label);
    }
  }
  function relevantMutation(entry) {
    const target =
      entry.target.nodeType === Node.ELEMENT_NODE
        ? entry.target
        : entry.target.parentElement;
    if (
      !target ||
      target.closest(
        ".nai-mi-dialog, .nai-mi-host-status, .nai-mi-open, .nai-mi-connection-image",
      )
    )
      return false;
    if (target === document.documentElement) return true;
    // Image changes matter only while a saved thumbnail awaits native hydration.
    if (entry.type === "attributes")
      return thumbnails.size > 0 && !!target.closest("[data-connection-id]");
    if (target.closest(".mari-editor-shell")) return true;
    if (thumbnails.size && target.closest("[data-connection-id]")) return true;
    if (entry.type !== "childList") return false;
    // Check changed branches for editor/list replacement, not the whole page.
    const selector = thumbnails.size
      ? ".mari-editor-shell, [data-connection-id]"
      : ".mari-editor-shell";
    return [...entry.addedNodes, ...entry.removedNodes].some(
      (node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches(selector) || node.querySelector(selector)),
    );
  }
  const observer = new MutationObserver((entries) => {
    if (scanning || stopped || !entries.some(relevantMutation)) return;
    scanning = true;
    marinara.setTimeout(() => {
      scanning = false;
      scan();
    }, 80);
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["lang"],
  });
  scan();
  marinara.onCleanup(() => {
    stopped = true;
    document.removeEventListener("click", rememberConnection, true);
    document.removeEventListener("input", rememberNameEdit, true);
    selectedConnectionId = null;
    for (const controller of requests) controller.abort();
    requests.clear();
    thumbnails.clear();
    document
      .querySelectorAll(".nai-mi-connection-image")
      .forEach((image) => image.remove());
    observer.disconnect();
    dismiss();
    for (const state of hosts.values()) {
      state.button.remove();
      state.status.remove();
      state.parent.removeAttribute("data-nai-import-host");
    }
    hosts.clear();
  });
})();
