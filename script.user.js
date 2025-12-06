// ==UserScript==
// @name         CCO Trade-up Float Calculator
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Calculates trade-up output floats and chances for possible skins
// @author       You
// @match        https://case-clicker.com/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function() {
    'use strict';

    let floatDisplayElement = null;
    let modalObserver = null;
    let updateTimer = null;
    let isUpdating = false;
    let SKINS_DATABASE = [];
    let skinsDataLoaded = false;
    let loadingAttempted = false;

    // Load skins database from GitHub
    async function loadSkinsDatabase() {
        if (loadingAttempted) return;
        loadingAttempted = true;

        try {
            console.log('Loading skins database from GitHub...');
            const response = await fetch("https://raw.githubusercontent.com/wkRaphael/CCO-Tradeup-Script/refs/heads/main/skins.json", {
                method: "GET",
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            SKINS_DATABASE = data;
            skinsDataLoaded = true;
            console.log('Skins database loaded successfully:', SKINS_DATABASE.length, 'skins');

            // Update display if modal is already open
            if (floatDisplayElement) {
                updateFloatDisplay();
            }
        } catch (error) {
            console.error('Failed to load skins database:', error);
            skinsDataLoaded = false;

            // Update display to show error
            if (floatDisplayElement) {
                updateFloatDisplay();
            }
        }
    }

    // Rarity hierarchy for trade-ups (updated with all CS:GO rarities)
    const RARITY_ORDER = [
        "Consumer Grade",
        "Industrial Grade",
        "Mil-Spec Grade",
        "Restricted",
        "Classified",
        "Covert"
    ];

    console.log('Rarity order loaded:', RARITY_ORDER);

    function parseFloatValue(text) {
        const cleaned = text.replace(/\.\.\./g, '').trim();

        if (/^[\d.]+e[+-]?\d+$/i.test(cleaned) || /^\d*\.\d+$/.test(cleaned) || /^\d+\.\d*$/.test(cleaned)) {
            const value = parseFloat(cleaned);
            if (!isNaN(value) && value >= 0 && value <= 1) {
                return value;
            }
        }
        return null;
    }

    function extractFloatFromCard(card) {
        // Strategy 1: Look for title attributes with float values
        const elementsWithTitle = card.querySelectorAll('[title*="|"]');
        for (let element of elementsWithTitle) {
            const title = element.getAttribute('title');
            if (title && title.includes('|')) {
                const parts = title.split('|');
                for (let part of parts.reverse()) {
                    const trimmed = part.trim();
                    const value = parseFloatValue(trimmed);
                    if (value !== null) {
                        return value;
                    }
                }
            }
        }

        // Strategy 2: Look for float-like text content
        const allElements = card.querySelectorAll('p, span');
        for (let element of allElements) {
            const text = element.textContent;
            if (text.includes('0.') || text.includes('e-') || text.includes('E-')) {
                const value = parseFloatValue(text);
                if (value !== null) {
                    return value;
                }
            }
        }

        return null;
    }

    function extractSkinNameFromCard(card) {
        // First try to get the name from the image alt attribute
        const img = card.querySelector('img.mantine-Image-root');
        if (img && img.alt) {
            let skinName = img.alt.trim();

            // Remove StatTrak™ prefix if present
            skinName = skinName.replace(/^StatTrak™\s*/, '');

            // Remove condition suffix (in parentheses) if present
            skinName = skinName.replace(/\s*\([^)]*\)$/, '');

            if (skinName) {
                console.log('Extracted skin name from alt:', skinName);
                return skinName;
            }
        }

        // Fallback to the old method using blue text elements
        const blueTextElements = card.querySelectorAll('p[style*="color: rgb(75, 105, 255)"]');

        let weaponName = '';
        let skinName = '';

        for (let i = 0; i < blueTextElements.length; i++) {
            const text = blueTextElements[i].textContent.trim();

            if (['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle-Scarred'].includes(text)) {
                continue;
            }

            if (i === 0) {
                weaponName = text;
            } else if (i === 1) {
                skinName = text;
                break;
            }
        }

        if (weaponName && skinName) {
            const fallbackName = `${weaponName} | ${skinName}`;
            console.log('Extracted skin name from text elements:', fallbackName);
            return fallbackName;
        }

        console.warn('Could not extract skin name from card');
        return weaponName || 'Unknown Skin';
    }

    function getSkinData(skinName) {
        return SKINS_DATABASE.find(skin =>
            skin.name.toLowerCase() === skinName.toLowerCase()
        );
    }

    function getNextRarity(currentRarity) {
        const currentIndex = RARITY_ORDER.indexOf(currentRarity);
        if (currentIndex >= 0 && currentIndex < RARITY_ORDER.length - 1) {
            return RARITY_ORDER[currentIndex + 1];
        }
        return null;
    }

    function calculateOutputFloat(inputAvgFloat, outputSkin) {
        if (outputSkin.minFloat === undefined || outputSkin.maxFloat === undefined) {
            return null;
        }

        // Trade-up formula: (outputMaxFloat - outputMinFloat) * averageFloat
        const calculatedFloat = (outputSkin.maxFloat - outputSkin.minFloat) * inputAvgFloat;

        // Determine condition addition based on where the skin's minFloat falls
        let conditionAddition = 0;

        if (outputSkin.minFloat <= 0.07) {
            // Skin can be Factory New, add 0
            conditionAddition = 0.0;
        } else if (outputSkin.minFloat <= 0.15) {
            // Skin starts in MW range, add MW minimum
            conditionAddition = 0.07;
        } else if (outputSkin.minFloat <= 0.38) {
            // Skin starts in FT range, add FT minimum
            conditionAddition = 0.15;
        } else if (outputSkin.minFloat <= 0.45) {
            // Skin starts in WW range, add WW minimum
            conditionAddition = 0.38;
        } else {
            // Skin starts in BS range, add BS minimum
            conditionAddition = 0.45;
        }

        // Only add condition minimum if calculatedFloat is less than it
        // If calculatedFloat is already higher, don't add anything
        const finalFloat = calculatedFloat >= conditionAddition ?
            calculatedFloat : calculatedFloat + conditionAddition;

        return finalFloat;
    }

    function calculateTradeUpData() {
        const modalBody = document.querySelector('.mantine-Modal-body');
        if (!modalBody) return null;

        const cards = modalBody.querySelectorAll('.mantine-Card-root[data-with-border="true"]');
        const inputItems = [];

        cards.forEach(card => {
            const floatValue = extractFloatFromCard(card);
            const skinName = extractSkinNameFromCard(card);

            if (floatValue !== null && skinName) {
                const skinData = getSkinData(skinName);
                inputItems.push({
                    name: skinName,
                    float: floatValue,
                    skinData: skinData
                });
            }
        });

        if (inputItems.length === 0) return null;

        // Calculate average float
        const totalFloat = inputItems.reduce((sum, item) => sum + item.float, 0);
        const averageFloat = totalFloat / inputItems.length;

        // Count occurrences of each skin for input probabilities
        const inputCounts = {};
        inputItems.forEach(item => {
            inputCounts[item.name] = (inputCounts[item.name] || 0) + 1;
        });

        // Calculate input probabilities
        const inputProbabilities = {};
        Object.keys(inputCounts).forEach(skinName => {
            inputProbabilities[skinName] = (inputCounts[skinName] / inputItems.length) * 100;
        });

        // Determine input rarity - try multiple approaches
        let inputRarity = null;
        let inputCollections = new Set();

        // First try: get rarity from skins that are found in database
        const itemsWithData = inputItems.filter(item => item.skinData);
        if (itemsWithData.length > 0) {
            inputRarity = itemsWithData[0].skinData.rarity;
            itemsWithData.forEach(item => {
                if (item.skinData.collection) {
                    inputCollections.add(item.skinData.collection);
                }
            });
        }

        // If we couldn't determine rarity from database, try to infer from context
        // This is a fallback approach
        if (!inputRarity) {
            console.warn('Could not determine input rarity from database, using fallback detection');
            // Could add logic here to detect rarity from other UI elements if needed
            // For now, we'll assume the most common case and let the user know
        }

        console.log('Input rarity detected:', inputRarity);
        console.log('Input collections:', Array.from(inputCollections));

        const nextRarity = getNextRarity(inputRarity);
        const possibleOutputs = [];

        if (nextRarity && (inputCollections.size > 0 || !inputRarity)) {
            // If we have collections, use them; otherwise search all collections
            const searchCollections = inputCollections.size > 0 ? inputCollections : new Set();

            SKINS_DATABASE.forEach(skin => {
                const matchesRarity = skin.rarity === nextRarity;
                const matchesCollection = inputCollections.size === 0 || inputCollections.has(skin.collection);

                if (matchesRarity && matchesCollection) {
                    const outputFloat = calculateOutputFloat(averageFloat, skin);
                    possibleOutputs.push({
                        ...skin,
                        outputFloat: outputFloat,
                        tickets: 0 // Will be calculated below
                    });
                }
            });

            console.log('Found possible outputs:', possibleOutputs.length);

            // Calculate tickets for each output based on input skins from same collection
            possibleOutputs.forEach(output => {
                // Count how many input skins are from the same collection as this output
                const inputSkinsFromSameCollection = inputItems.filter(inputItem =>
                    inputItem.skinData && inputItem.skinData.collection === output.collection
                ).length;

                // Each output skin gets 1 ticket per input skin from its collection
                output.tickets = inputSkinsFromSameCollection;
            });

            // Calculate probabilities based on tickets
            const totalTickets = possibleOutputs.reduce((sum, output) => sum + output.tickets, 0);
            if (totalTickets > 0) {
                possibleOutputs.forEach(output => {
                    output.probability = (output.tickets / totalTickets) * 100;
                });
            }
        }

        return {
            inputItems,
            averageFloat,
            inputCounts,
            inputProbabilities,
            possibleOutputs,
            inputRarity,
            nextRarity,
            inputCollections: Array.from(inputCollections)
        };
    }

    function formatFloat(value) {
        if (value === null || value === undefined) return 'N/A';

        if (value < 0.000001) {
            return value.toExponential(8);
        }
        if (value < 0.01) {
            return value.toFixed(15).replace(/0+$/, '').replace(/\.$/, '');
        }
        return value.toFixed(10);
    }

    function formatFloatCondition(float) {
        if (float === null || float === undefined) return { condition: "N/A", color: "#999" };
        if (float <= 0.07) return { condition: "FN", color: "#4CAF50" };
        if (float <= 0.15) return { condition: "MW", color: "#8BC34A" };
        if (float <= 0.38) return { condition: "FT", color: "#FF9800" };
        if (float <= 0.45) return { condition: "WW", color: "#FF5722" };
        return { condition: "BS", color: "#795548" };
    }

    function updateFloatDisplay() {
        if (isUpdating || !floatDisplayElement) return;
        isUpdating = true;

        try {
            // Handle loading states
            if (!skinsDataLoaded && loadingAttempted) {
                floatDisplayElement.innerHTML = `
                    <div style="text-align: center; padding: 12px; border: 1px solid #f44336; border-radius: 8px; background: rgba(244,67,54,0.1);">
                        <span style="color: #f44336;">Failed to load skins database from GitHub</span>
                    </div>
                `;
                return;
            } else if (!skinsDataLoaded) {
                floatDisplayElement.innerHTML = `
                    <div style="text-align: center; padding: 12px; border: 1px solid #f39c12; border-radius: 8px; background: rgba(243,156,18,0.1);">
                        <span style="color: #f39c12;">Loading skins database...</span>
                    </div>
                `;
                return;
            }

            const result = calculateTradeUpData();

            if (!result) {
                floatDisplayElement.innerHTML = `
                    <div style="text-align: center; padding: 12px; border: 1px solid #444; border-radius: 8px; background: rgba(0,0,0,0.3);">
                        <span style="color: #999;">No valid items found in trade-up</span>
                    </div>
                `;
                return;
            }

            const avgFormatted = formatFloat(result.averageFloat);
            const fullPrecision = result.averageFloat.toString();
            const condition = formatFloatCondition(result.averageFloat);

            let html = `
                <div style="padding: 12px; border: 1px solid #444; border-radius: 8px; background: rgba(0,0,0,0.3); font-family: inherit;">
                    <div style="text-align: center; margin-bottom: 12px;">
                        <div style="font-size: 14px; color: #888; margin-bottom: 4px;">
                            Average Input Float (${result.inputItems.length} items)
                        </div>
                        <div style="display: flex; justify-content: center; align-items: center; gap: 10px; margin-bottom: 4px;">
                            <div id="float-value-display" style="font-size: 18px; font-weight: bold; color: #f39c12; cursor: pointer;"
                                 title="Click to copy: ${fullPrecision}"
                                 data-float="${fullPrecision}">
                                ${avgFormatted}
                            </div>
                            <div style="padding: 2px 6px; background-color: ${condition.color}; color: white; border-radius: 4px; font-size: 12px; font-weight: bold;">
                                ${condition.condition}
                            </div>
                        </div>
                        <div style="font-size: 10px; color: #666;">Click float value to copy full precision</div>
                    </div>
            `;

            // Input items breakdown
            if (result.inputItems.length > 1) {
                html += `
                    <div style="margin-bottom: 12px;">
                        <div style="font-size: 12px; color: #888; margin-bottom: 6px;">Input Items:</div>
                `;

                Object.entries(result.inputProbabilities).forEach(([skinName, probability]) => {
                    const count = result.inputCounts[skinName];
                    html += `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin: 2px 0; font-size: 11px; padding: 2px 4px; background: rgba(255,255,255,0.05); border-radius: 3px;">
                            <span style="color: #ccc; flex: 1;">${skinName}</span>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="color: #999;">×${count}</span>
                                <span style="color: #f39c12;">${probability.toFixed(1)}%</span>
                            </div>
                        </div>
                    `;
                });

                html += `</div>`;
            }

            // Possible trade-up outputs
            if (result.possibleOutputs.length > 0) {
                html += `
                    <div style="border-top: 1px solid #444; padding-top: 12px;">
                        <div style="font-size: 12px; color: #888; margin-bottom: 8px;">
                            Possible Outputs (${result.nextRarity}):
                        </div>
                `;

                result.possibleOutputs.forEach(output => {
                    const floatCondition = formatFloatCondition(output.outputFloat);
                    const outputFloatFormatted = formatFloat(output.outputFloat);

                    html += `
                        <div style="display: flex; justify-content: space-between; align-items: center; margin: 4px 0; padding: 6px 8px; background: rgba(255,255,255,0.05); border-radius: 4px; border-left: 3px solid ${floatCondition.color};">
                            <div style="flex: 1; min-width: 0; margin-right: 12px;">
                                <div style="font-size: 13px; color: #ccc; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${output.name}</div>
                                <div style="font-size: 10px; color: #888; margin-top: 1px;">${output.collection}</div>
                            </div>
                            <div style="display: flex; align-items: center; gap: 12px; flex-shrink: 0;">
                                <div style="text-align: center; min-width: 45px;">
                                    <div style="color: ${floatCondition.color}; font-weight: bold; font-size: 12px;">${floatCondition.condition}</div>
                                    <div style="color: #f39c12; font-size: 10px;">${outputFloatFormatted}</div>
                                </div>
                                <div style="text-align: center; min-width: 50px;">
                                    <div style="color: #4CAF50; font-size: 13px; font-weight: bold;">${output.probability.toFixed(1)}%</div>
                                    <div style="color: #999; font-size: 9px;">${output.tickets} ticket${output.tickets !== 1 ? 's' : ''}</div>
                                </div>
                            </div>
                        </div>
                    `;
                });

                html += `</div>`;
            } else if (result.inputRarity) {
                html += `
                    <div style="border-top: 1px solid #444; padding-top: 12px; text-align: center;">
                        <span style="color: #ff6b6b; font-size: 11px;">
                            ${result.nextRarity ?
                                `No ${result.nextRarity} skins found in database for collections: ${result.inputCollections.join(', ')}` :
                                `Cannot trade up from ${result.inputRarity} (already highest tier)`
                            }
                        </span>
                    </div>
                `;
            }

            // Database status
            html += `
                <div style="border-top: 1px solid #444; padding-top: 8px; text-align: center;">
                    <div style="font-size: 10px; color: #666;">
                        Database: ${SKINS_DATABASE.length} skins loaded
                        ${result.inputCollections.length > 0 ? `| Collections: ${result.inputCollections.join(', ')}` : ''}
                    </div>
                </div>
            `;

            html += `</div>`;

            floatDisplayElement.innerHTML = html;

            // Add click handler for copying float
            const floatDiv = document.getElementById('float-value-display');
            if (floatDiv) {
                floatDiv.onclick = () => {
                    const floatValue = floatDiv.getAttribute('data-float');
                    navigator.clipboard.writeText(floatValue).then(() => {
                        const originalText = floatDiv.textContent;
                        floatDiv.textContent = 'Copied!';
                        floatDiv.style.color = '#27ae60';
                        setTimeout(() => {
                            if (floatDiv) {
                                floatDiv.textContent = originalText;
                                floatDiv.style.color = '#f39c12';
                            }
                        }, 1000);
                    }).catch(err => {
                        // Fallback for older browsers
                        const textArea = document.createElement("textarea");
                        textArea.value = floatValue;
                        document.body.appendChild(textArea);
                        textArea.focus();
                        textArea.select();
                        try {
                            document.execCommand('copy');
                            const originalText = floatDiv.textContent;
                            floatDiv.textContent = 'Copied!';
                            floatDiv.style.color = '#27ae60';
                            setTimeout(() => {
                                if (floatDiv) {
                                    floatDiv.textContent = originalText;
                                    floatDiv.style.color = '#f39c12';
                                }
                            }, 1000);
                        } catch (e) {
                            console.error('Copy fallback failed:', e);
                        }
                        document.body.removeChild(textArea);
                    });
                };
            }

        } catch (error) {
            console.error('Error updating float display:', error);
            floatDisplayElement.innerHTML = `
                <div style="text-align: center; padding: 12px; border: 1px solid #f44336; border-radius: 8px; background: rgba(244,67,54,0.1);">
                    <span style="color: #f44336;">Error: ${error.message}</span>
                </div>
            `;
        } finally {
            isUpdating = false;
        }
    }

    function debouncedUpdate() {
        clearTimeout(updateTimer);
        updateTimer = setTimeout(updateFloatDisplay, 200);
    }

    function injectFloatDisplay(modalBody) {
        if (floatDisplayElement) {
            floatDisplayElement.remove();
            floatDisplayElement = null;
        }

        const existingCalculator = modalBody.querySelector('#tradeup-float-calculator');
        if (existingCalculator) {
            existingCalculator.remove();
        }

        const buttonsContainer = modalBody.querySelector('.mantine-Group-root');
        if (!buttonsContainer) return;

        floatDisplayElement = document.createElement('div');
        floatDisplayElement.id = 'tradeup-float-calculator';
        floatDisplayElement.style.cssText = `
            margin: 16px 0;
            font-family: inherit;
        `;

        buttonsContainer.parentElement.insertBefore(
            floatDisplayElement,
            buttonsContainer.nextSibling
        );

        updateFloatDisplay();
    }

    function checkForTradeUpModal() {
        const modalTitle = document.querySelector('.mantine-Modal-title');
        const modalBody = document.querySelector('.mantine-Modal-body');

        if (modalTitle && modalBody && modalTitle.textContent.includes('Trade up')) {
            const hasTradeUpButton = Array.from(modalBody.querySelectorAll('button'))
                .some(btn => btn.textContent.includes('Confirm Trade Up'));

            if (hasTradeUpButton && !document.getElementById('tradeup-float-calculator')) {
                // Load skins database if not already attempted
                if (!loadingAttempted) {
                    loadSkinsDatabase();
                }

                injectFloatDisplay(modalBody);

                if (modalObserver) modalObserver.disconnect();
                modalObserver = new MutationObserver((mutations) => {
                    let shouldUpdate = false;

                    mutations.forEach(mutation => {
                        mutation.addedNodes.forEach(node => {
                            if (node.nodeType === 1 && (
                                node.classList?.contains('mantine-Card-root') ||
                                node.querySelector?.('.mantine-Card-root')
                            )) {
                                shouldUpdate = true;
                            }
                        });

                        mutation.removedNodes.forEach(node => {
                            if (node.nodeType === 1 && (
                                node.classList?.contains('mantine-Card-root') ||
                                node.querySelector?.('.mantine-Card-root')
                            )) {
                                shouldUpdate = true;
                            }
                        });
                    });

                    if (shouldUpdate) {
                        debouncedUpdate();
                    }
                });

                modalObserver.observe(modalBody, {
                    childList: true,
                    subtree: true
                });
            }
        } else {
            if (floatDisplayElement) {
                floatDisplayElement.remove();
                floatDisplayElement = null;
            }
            if (modalObserver) {
                modalObserver.disconnect();
                modalObserver = null;
            }
        }
    }

    // Check for modals
    let checkInterval = 250;
    let checkCount = 0;

    function adaptiveCheck() {
        checkForTradeUpModal();
        checkCount++;

        // After 20 checks (5 seconds), slow down to every 500ms
        if (checkCount > 20 && checkInterval === 250) {
            checkInterval = 500;
            clearInterval(intervalId);
            intervalId = setInterval(adaptiveCheck, checkInterval);
        }
    }

    let intervalId = setInterval(adaptiveCheck, checkInterval);

    console.log('CCO Trade-up Calculator v0.1 loaded - Auto-fetching skins database from GitHub');
})();
