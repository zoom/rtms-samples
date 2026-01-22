import * as audio from './audio/audioHelper.js';
import * as video from './video/videoHelper.js';
import * as audiovideo from './audiovideo/audiovideoHelper.js';
import { UUIDHelper } from './filename/UUIDHelper.js';
import * as network from './network/networkHelper.js';
import { FileLogger } from '../rtmsManager/utils/FileLogger.js';
import { AudioGapFiller, VideoGapFiller, VideoJitterBuffer } from './gapfiller/index.js';

export { FileLogger, AudioGapFiller, VideoGapFiller, VideoJitterBuffer };

export const HelperManager = {
    audio,
    video,
    audiovideo,
    filename: UUIDHelper,
    network,
    gapfiller: {
        AudioGapFiller,
        VideoGapFiller,
        VideoJitterBuffer
    },
    utils: {
        FileLogger
    }
};

export default HelperManager;
