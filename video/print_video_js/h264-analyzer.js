class H264StreamAnalyzer {
    constructor(options = {}) {
        // Configuration
        this.logInterval = options.logInterval || 1; // Log every N frames
        this.statsInterval = options.statsInterval || 1; // Show stats every N frames
        this.enableDetailedLogging = options.enableDetailedLogging || false;
        this.enableConsoleOutput = options.enableConsoleOutput !== false; // Default true

        // Internal state
        this.sps = null;
        this.pps = null;
        this.frameCount = 0;
        this.frameTypes = [];
        this.timestamps = [];
        this.resolution = null;
        this.fps = null;
        this.isInitialized = false;
        this.lastLogTime = Date.now();

        // Stream info
        this.streamInfo = {
            isAnalyzing: false,
            totalFrames: 0,
            resolution: null,
            fps: null,
            frameTypeStats: {}
        };

        if (this.enableConsoleOutput) {
            console.log('🎥 H.264 Stream Analyzer initialized');
        }
    }

    // Find NAL unit start codes
    findNalUnits(buffer) {
        const nalUnits = [];
        let i = 0;

        while (i < buffer.length - 3) {
            if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
                if (buffer[i + 2] === 0x01) {
                    nalUnits.push(i + 3);
                    i += 3;
                } else if (buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
                    nalUnits.push(i + 4);
                    i += 4;
                } else {
                    i++;
                }
            } else {
                i++;
            }
        }

        return nalUnits;
    }

    // Bit stream reader class for accurate bit-level parsing
    createBitReader(buffer, startOffset = 0) {
        return {
            buffer: buffer,
            byteOffset: startOffset,
            bitOffset: 0,

            readBit() {
                if (this.byteOffset >= this.buffer.length) {
                    return 0;
                }

                const byte = this.buffer[this.byteOffset];
                const bit = (byte >> (7 - this.bitOffset)) & 1;

                this.bitOffset++;
                if (this.bitOffset === 8) {
                    this.bitOffset = 0;
                    this.byteOffset++;
                }

                return bit;
            },

            readBits(n) {
                let result = 0;
                for (let i = 0; i < n; i++) {
                    result = (result << 1) | this.readBit();
                }
                return result;
            },

            readUE() {
                let leadingZeros = 0;
                while (this.readBit() === 0) {
                    leadingZeros++;
                }

                if (leadingZeros === 0) {
                    return 0;
                }

                const value = this.readBits(leadingZeros);
                return value + (1 << leadingZeros) - 1;
            },

            readSE() {
                const value = this.readUE();
                return value % 2 === 0 ? -(value >> 1) : (value + 1) >> 1;
            },

            skipBits(n) {
                for (let i = 0; i < n; i++) {
                    this.readBit();
                }
            }
        };
    }

    // Parse SPS for resolution with improved accuracy
    parseSPS(buffer, offset) {
        if (offset >= buffer.length) return null;

        const nalUnitType = buffer[offset] & 0x1F;
        if (nalUnitType !== 7) return null;

        try {
            const reader = this.createBitReader(buffer, offset + 1);

            // Read profile_idc
            const profileIdc = reader.readBits(8);

            // Skip constraint_set flags (6 bits) and reserved_zero_2bits (2 bits)
            reader.skipBits(8);

            // Read level_idc
            const levelIdc = reader.readBits(8);

            // Parse seq_parameter_set_id
            const seqParameterSetId = reader.readUE();

            let chromaFormatIdc = 1; // Default value
            let separateColourPlaneFlag = 0;
            let bitDepthLumaMinus8 = 0;
            let bitDepthChromaMinus8 = 0;

            // Handle high profile extensions
            if (profileIdc === 100 || profileIdc === 110 || profileIdc === 122 || profileIdc === 244 ||
                profileIdc === 44 || profileIdc === 83 || profileIdc === 86 || profileIdc === 118 ||
                profileIdc === 128 || profileIdc === 138 || profileIdc === 139 || profileIdc === 134) {

                // Parse chroma_format_idc
                chromaFormatIdc = reader.readUE();

                if (chromaFormatIdc === 3) {
                    separateColourPlaneFlag = reader.readBit();
                }

                // Parse bit_depth_luma_minus8
                bitDepthLumaMinus8 = reader.readUE();

                // Parse bit_depth_chroma_minus8
                bitDepthChromaMinus8 = reader.readUE();

                // Skip qpprime_y_zero_transform_bypass_flag
                reader.readBit();

                // Parse seq_scaling_matrix_present_flag
                const seqScalingMatrixPresentFlag = reader.readBit();

                if (seqScalingMatrixPresentFlag) {
                    const numScalingLists = (chromaFormatIdc !== 3) ? 8 : 12;
                    for (let i = 0; i < numScalingLists; i++) {
                        const seqScalingListPresentFlag = reader.readBit();
                        if (seqScalingListPresentFlag) {
                            // Skip scaling list data
                            const sizeOfScalingList = i < 6 ? 16 : 64;
                            let lastScale = 8;
                            let nextScale = 8;

                            for (let j = 0; j < sizeOfScalingList; j++) {
                                if (nextScale !== 0) {
                                    const deltaScale = reader.readSE();
                                    nextScale = (lastScale + deltaScale + 256) % 256;
                                }
                                lastScale = nextScale === 0 ? lastScale : nextScale;
                            }
                        }
                    }
                }
            }

            // Parse log2_max_frame_num_minus4
            const log2MaxFrameNumMinus4 = reader.readUE();

            // Parse pic_order_cnt_type
            const picOrderCntType = reader.readUE();

            if (picOrderCntType === 0) {
                // Parse log2_max_pic_order_cnt_lsb_minus4
                const log2MaxPicOrderCntLsbMinus4 = reader.readUE();
            } else if (picOrderCntType === 1) {
                // Skip delta_pic_order_always_zero_flag
                reader.readBit();

                // Parse offset_for_non_ref_pic
                const offsetForNonRefPic = reader.readSE();

                // Parse offset_for_top_to_bottom_field
                const offsetForTopToBottomField = reader.readSE();

                // Parse num_ref_frames_in_pic_order_cnt_cycle
                const numRefFramesInPicOrderCntCycle = reader.readUE();

                // Skip offset_for_ref_frame values
                for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
                    const offsetForRefFrame = reader.readSE();
                }
            }

            // Parse max_num_ref_frames
            const maxNumRefFrames = reader.readUE();

            // Skip gaps_in_frame_num_value_allowed_flag
            reader.readBit();

            // Parse pic_width_in_mbs_minus1
            const picWidthInMbsMinus1 = reader.readUE();

            // Parse pic_height_in_map_units_minus1
            const picHeightInMapUnitsMinus1 = reader.readUE();

            // Parse frame_mbs_only_flag
            const frameMbsOnlyFlag = reader.readBit();

            if (!frameMbsOnlyFlag) {
                // Skip mb_adaptive_frame_field_flag
                reader.readBit();
            }

            // Skip direct_8x8_inference_flag
            reader.readBit();

            // Parse frame_cropping_flag
            const frameCroppingFlag = reader.readBit();

            let frameCropLeftOffset = 0;
            let frameCropRightOffset = 0;
            let frameCropTopOffset = 0;
            let frameCropBottomOffset = 0;

            if (frameCroppingFlag) {
                frameCropLeftOffset = reader.readUE();
                frameCropRightOffset = reader.readUE();
                frameCropTopOffset = reader.readUE();
                frameCropBottomOffset = reader.readUE();
            }

            // Calculate resolution
            const picWidthInMbs = picWidthInMbsMinus1 + 1;
            const picHeightInMbs = picHeightInMapUnitsMinus1 + 1;

            let width = picWidthInMbs * 16;
            let height = picHeightInMbs * 16;

            // Adjust for field/frame coding
            if (!frameMbsOnlyFlag) {
                height *= 2;
            }

            // Apply cropping
            if (frameCroppingFlag) {
                const cropUnitX = chromaFormatIdc === 0 ? 1 : (chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1);
                const cropUnitY = chromaFormatIdc === 0 ? 1 : (chromaFormatIdc === 1 ? 2 : 1);

                if (!frameMbsOnlyFlag) {
                    cropUnitY *= 2;
                }

                width -= (frameCropLeftOffset + frameCropRightOffset) * cropUnitX;
                height -= (frameCropTopOffset + frameCropBottomOffset) * cropUnitY;
            }

            this.resolution = { width, height };
            this.streamInfo.resolution = this.resolution;
            this.sps = {
                width,
                height,
                profileIdc,
                levelIdc,
                chromaFormatIdc,
                frameMbsOnlyFlag,
                frameCroppingFlag,
                cropOffsets: {
                    left: frameCropLeftOffset,
                    right: frameCropRightOffset,
                    top: frameCropTopOffset,
                    bottom: frameCropBottomOffset
                }
            };

            if (this.enableConsoleOutput && !this.isInitialized) {
                console.log(`📐 Resolution detected: ${width}x${height}`);
                if (this.enableDetailedLogging) {
                    console.log(`   Profile: ${profileIdc}, Level: ${levelIdc}`);
                    console.log(`   Chroma Format: ${chromaFormatIdc}`);
                    console.log(`   Frame MBs Only: ${frameMbsOnlyFlag}`);
                    if (frameCroppingFlag) {
                        console.log(`   Cropping: L=${frameCropLeftOffset}, R=${frameCropRightOffset}, T=${frameCropTopOffset}, B=${frameCropBottomOffset}`);
                    }
                }
            }

            return this.sps;
        } catch (error) {
            if (this.enableConsoleOutput) {
                console.error('❌ Error parsing SPS:', error.message);
            }
            return null;
        }
    }

    // Get frame type
    getFrameType(buffer, offset) {
        if (offset >= buffer.length) return 'UNKNOWN';

        const nalUnitType = buffer[offset] & 0x1F;

        switch (nalUnitType) {
            case 1: // Non-IDR coded slice
                return this.parseSliceType(buffer, offset + 1);
            case 5: // IDR coded slice (always I-frame)
                return 'I';
            case 6:
                return 'SEI';
            case 7:
                return 'SPS';
            case 8:
                return 'PPS';
            case 9:
                return 'AUD';
            default:
                return 'UNKNOWN';
        }
    }

    // // Parse slice type with better error handling and logging
    // parseSliceType(buffer, offset) {
    //     try {
    //         const reader = this.createBitReader(buffer, offset);

    //         // Parse first_mb_in_slice
    //         const firstMbInSlice = reader.readUE();

    //         // Parse slice_type
    //         const sliceType = reader.readUE();

    //         const sliceTypeMap = {
    //             0: 'P', 1: 'B', 2: 'I', 3: 'P', 4: 'I',
    //             5: 'P', 6: 'B', 7: 'I', 8: 'P', 9: 'I'
    //         };

    //         const frameType = sliceTypeMap[sliceType];

    //         if (this.enableDetailedLogging && frameType) {
    //             console.log(`   Slice parsing: type=${sliceType} -> ${frameType}, first_mb=${firstMbInSlice}`);
    //         }

    //         return frameType || 'UNKNOWN';
    //     } catch (error) {
    //         if (this.enableDetailedLogging) {
    //             console.log(`   Slice parsing failed: ${error.message}`);
    //         }
    //         return 'UNKNOWN';
    //     }
    // }

    // Parse slice type with B-frame detection
    parseSliceType(buffer, offset) {
        try {
            const reader = this.createBitReader(buffer, offset);

            // Parse first_mb_in_slice (UE)
            reader.readUE();

            // Parse slice_type (UE)
            const sliceType = reader.readUE();

            // Map of slice_type values to frame types
            const sliceTypeMap = {
                0: 'P',  // P slice
                1: 'B',  // B slice
                2: 'I',  // I slice
                3: 'SP', // SP slice
                4: 'SI', // SI slice
                5: 'P',  // P slice (reference)
                6: 'B',  // B slice (reference)
                7: 'I',  // I slice (reference)
                8: 'SP', // SP slice (reference)
                9: 'SI'  // SI slice (reference)
            };

            const frameType = sliceTypeMap[sliceType];

            if (this.enableDetailedLogging) {
                console.log(`   Slice parsing: slice_type=${sliceType} → ${frameType || 'UNKNOWN'}`);
            }

            return frameType || 'UNKNOWN';
        } catch (error) {
            if (this.enableDetailedLogging) {
                console.log(`   Slice parsing failed: ${error.message}`);
            }
            return 'UNKNOWN';
        }
    }


    // Calculate FPS
    calculateFPS() {
        if (this.timestamps.length < 5) return null;

        const timeDiffs = [];
        for (let i = 1; i < this.timestamps.length; i++) {
            timeDiffs.push(this.timestamps[i] - this.timestamps[i - 1]);
        }

        const avgTimeDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
        this.fps = Math.round(1000 / avgTimeDiff * 100) / 100;
        this.streamInfo.fps = this.fps;

        return this.fps;
    }

    // Update statistics
    updateStats() {
        const frameTypeCounts = this.frameTypes.reduce((acc, type) => {
            acc[type] = (acc[type] || 0) + 1;
            return acc;
        }, {});

        this.streamInfo.frameTypeStats = frameTypeCounts;
        this.streamInfo.totalFrames = this.frameCount;
    }

    // Log frame info
    logFrameInfo(frameTypes, currentFPS) {

        if (!this.enableConsoleOutput) return;

        const now = Date.now();
        // if (now - this.lastLogTime < 1000){
        //     return; // Throttle logging
        // } 

        this.lastLogTime = now;

        const frameTypeStr = frameTypes.join('/') || 'Unknown';
        const resolutionStr = this.resolution ? `${this.resolution.width}x${this.resolution.height}` : 'Unknown';
        const fpsStr = currentFPS ? `${currentFPS.toFixed(2)} FPS` : 'Calculating...';


        console.log(`🎬 Frame #${this.frameCount} | Type: ${frameTypeStr} | ${resolutionStr} | ${fpsStr}`);
        //process.stdout.write(`\r🎬 Frame #${this.frameCount} | Type: ${frameTypeStr} | ${resolutionStr} | ${fpsStr}`);


    }

    // Log statistics
    logStats() {
        if (!this.enableConsoleOutput) return;

        console.log('\n📊 Stream Statistics:');
        console.log(`   Total Frames: ${this.frameCount}`);
        console.log(`   Resolution: ${this.resolution ? `${this.resolution.width}x${this.resolution.height}` : 'Unknown'}`);
        console.log(`   FPS: ${this.fps.toFixed(2) || 'Calculating...'}`);


        if (this.frameTypes.length > 0) {
            const stats = this.streamInfo.frameTypeStats;
            console.log('   Frame Types (Number of chunks):');
            Object.keys(stats).forEach(type => {
                const count = stats[type];
                const percentage = Math.round((count / this.frameTypes.length) * 100);
                console.log(`     ${type}-frames: ${count} (${percentage}%)`);
            });
        }
        console.log('');
    }

    // Main method - this is what you call from index.js
    processFrame(videoData, timestamp) {
        try {
            // Convert base64 to buffer
            const buffer = Buffer.from(videoData, 'base64');

            // Set analyzing flag
            if (!this.streamInfo.isAnalyzing) {
                this.streamInfo.isAnalyzing = true;
                if (this.enableConsoleOutput) {
                    console.log('🚀 Starting H.264 stream analysis...');
                }
            }

            // Find NAL units
            const nalUnits = this.findNalUnits(buffer);
            if (nalUnits.length === 0) return this.streamInfo;

            // Store timestamp
            this.timestamps.push(timestamp);
            if (this.timestamps.length > 30) {
                this.timestamps.shift();
            }

            // Analyze NAL units
            const frameTypes = [];
            for (const nalStart of nalUnits) {
                if (nalStart < buffer.length) {
                    const nalUnitType = buffer[nalStart] & 0x1F;
                    const frameType = this.getFrameType(buffer, nalStart);

                    if (this.enableDetailedLogging) {
                        console.log(`   NAL unit: type=${nalUnitType}, frame_type=${frameType}`);
                    }

                    if (frameType === 'SPS' && !this.sps) {
                        this.parseSPS(buffer, nalStart);
                        this.isInitialized = true;
                    }

                    frameTypes.push(frameType);
                    this.frameTypes.push(frameType);
                }
            }

            // Increment frame count
            this.frameCount++;

            // Calculate FPS
            let currentFPS = null;
            if (this.timestamps.length >= 10) {
                currentFPS = this.calculateFPS();

                // Log FPS detection
                if (currentFPS && !this.streamInfo.fps && this.enableConsoleOutput) {
                    console.log(`⚡ FPS detected: ${currentFPS}`);
                }
            }

            // Update statistics
            this.updateStats();



            // Log frame info periodically
            if (this.frameCount % this.logInterval === 0) {
                this.logFrameInfo(frameTypes, currentFPS);
            }
            // Log detailed statistics periodically
            if (this.frameCount % this.statsInterval === 0) {
                
                this.logStats();
            }

            return this.streamInfo;

        } catch (error) {
            if (this.enableConsoleOutput) {
                console.error('❌ Error processing frame:', error.message);
            }
            return this.streamInfo;
        }
    }

    // Get current stream info (optional - for manual queries)
    getStreamInfo() {
        return {
            ...this.streamInfo,
            isInitialized: this.isInitialized,
            currentFPS: this.fps
        };
    }

    // Reset analyzer (optional)
    reset() {
        this.sps = null;
        this.pps = null;
        this.frameCount = 0;
        this.frameTypes = [];
        this.timestamps = [];
        this.resolution = null;
        this.fps = null;
        this.isInitialized = false;
        this.streamInfo = {
            isAnalyzing: false,
            totalFrames: 0,
            resolution: null,
            fps: null,
            frameTypeStats: {}
        };

        if (this.enableConsoleOutput) {
            console.log('🔄 H.264 Stream Analyzer reset');
        }
    }
}

export default H264StreamAnalyzer;