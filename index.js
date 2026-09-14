const { WebhookClient, AttachmentBuilder } = require('discord.js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const axios = require('axios');
const path = require('path');
const sharp = require('sharp');

puppeteer.use(StealthPlugin());

class MangaBot {
    constructor() {
        this.configPath = path.join(__dirname, 'config.json');
        this.config = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
    }

    async run() {
        console.log("🚀 [SISTEMA] Iniciando MangaBot (Persistencia Full)...");
        const browser = await puppeteer.launch({ 
            headless: "new", 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'] 
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 1080 });

        for (const [name, data] of Object.entries(this.config)) {
            try {
                console.log(`\n========================================`);
                console.log(`🔍 REVISANDO: ${name}`);
                console.log(`========================================`);
                
                let searching = true;
                while (searching) {
                    let currentNum = this.config[name].last.toString().split(' ')[0];
                    let nextNum = (parseFloat(currentNum) + 1).toString();
                    
                    // 1. INTENTAR SIGUIENTE NORMAL
                    let targetUrl = name === "Gachiakuta" ? `${data.url}${nextNum}-espanol/` : `${data.url}${nextNum}`;
                    console.log(`\n[${name}] Intentando Capítulo Normal: ${nextNum}`);
                    let foundNormal = await this.processChapter(page, name, nextNum, targetUrl, data.webhook);

                    if (foundNormal) {
                        // Reset de parte al encontrar un capítulo entero nuevo
                        this.config[name].last_part = 0;
                        this.saveConfig();
                        continue; 
                    }

                    // 2. INTENTAR PARTE 2 (Solo si no se ha enviado ya)
                    const lastPartSent = this.config[name].last_part || 0;
                    if (name === "Gachiakuta" && lastPartSent < 2) {
                        let part2Url = `${data.url}${currentNum}-parte-2-espanol/`;
                        console.log(`\n[${name}] Intentando Parte 2 del actual: ${currentNum}`);
                        let foundP2 = await this.processChapter(page, name, `${currentNum} P2`, part2Url, data.webhook, true);
                        
                        if (foundP2) {
                            this.config[name].last_part = 2;
                            this.saveConfig();
                            continue;
                        }
                    }
                    searching = false;
                }
            } catch (err) {
                console.error(`[${name}] 🚨 ERROR: ${err.message}`);
            }
        }
        await browser.close();
        console.log("\n✅ [SISTEMA] Proceso finalizado.");
    }

    saveConfig() {
        fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    }

    async processChapter(page, name, displayNum, url, webhookUrl, isPart2 = false) {
        const capturedUrls = new Set();
        console.log(`   [LOG] Navegando a: ${url}`);
        
        page.removeAllListeners('request');
        page.on('request', request => {
            const reqUrl = request.url();
            if (reqUrl.match(/\.(jpg|jpeg|png|webp)/i)) {
                if (reqUrl.includes('googleusercontent') || reqUrl.includes('one-piece-fans') || reqUrl.includes('blogger')) {
                    if (!reqUrl.includes('logo') && !reqUrl.includes('avatar') && !reqUrl.includes('favicon')) {
                        if (!capturedUrls.has(reqUrl)) {
                            capturedUrls.add(reqUrl);
                            console.log(`   [RED] + Imagen: ...${reqUrl.slice(-25)}`);
                        }
                    }
                }
            }
        });

        const response = await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);

        if (!response || response.status() !== 200) {
            console.log(`   ❌ [INFO] ${displayNum} no disponible (Status: ${response ? response.status() : 'Error'}).`);
            return false;
        }

        const finalUrl = page.url();
        if (isPart2 && !finalUrl.includes('parte-2')) {
            console.log(`   [AVISO] Redirección detectada. La Parte 2 no existe.`);
            return false;
        }

        console.log(`   [LOG] Status 200 OK. Scroll y renderizado...`);
        await page.evaluate(async () => {
            await new Promise(r => {
                let h = 0;
                let t = setInterval(() => { 
                    window.scrollBy(0, 500); h += 500;
                    if (h >= document.body.scrollHeight) { clearInterval(t); r(); }
                }, 150);
            });
        });

        await new Promise(r => setTimeout(r, 5000));
        
        const finalImages = [...capturedUrls];
        if (finalImages.length > 2) {
            console.log(`   ✅ [ÉXITO] Generando PDF: ${displayNum} (${finalImages.length} imágenes)`);
            const pdfPath = path.join(__dirname, `temp_${name}.pdf`);
            await this.generatePDF(finalImages, pdfPath, url);
            
            console.log(`   [LOG] Enviando a Discord...`);
            const webhook = new WebhookClient({ url: webhookUrl.trim() });
            await webhook.send({
                content: `✅ **${name}**: Capítulo **${displayNum}**`,
                files: [new AttachmentBuilder(pdfPath, { name: `${name}_${displayNum}.pdf` })]
            });

            if (!isPart2) {
                console.log(`   [LOG] Actualizando JSON a: ${displayNum}`);
                this.config[name].last = displayNum;
            }
            
            if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
            return true;
        }
        return false;
    }

    async generatePDF(urls, filePath, referer) {
        const doc = new PDFDocument({ autoFirstPage: false, compress: true });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        for (const url of urls) {
            try {
                const res = await axios.get(url, { 
                    responseType: 'arraybuffer',
                    headers: { 'Referer': referer, 'User-Agent': 'Mozilla/5.0' }
                });
                const buf = await sharp(res.data).resize(1100).jpeg({ quality: 75 }).toBuffer();
                const img = doc.openImage(buf);
                doc.addPage({ size: [img.width, img.height] }).image(img, 0, 0);
            } catch (e) {}
        }
        doc.end();
        return new Promise(r => stream.on('finish', r));
    }
}

new MangaBot().run();