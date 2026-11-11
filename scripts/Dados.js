'use strict';

import calcularDistancia from './Math.js';
import { config, normalizarNome, nomesCombinam, nomeDoPosto } from './Regras.js';

/* ========================================
   ESTADO DOS DADOS
   ======================================== */
export let postosANP = [];
export let gradeANP = new Map();
export let bandeirasLogo = {};
export let erroANP = false;
export let dataColetaANP = '';
export let elementosOsm = null;

const coordenadasValidas = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng);

const chaveCelula = (linha, coluna) => `${linha},${coluna}`;

/* ========================================
   BASE DE PREÇOS (ANP)
   ======================================== */
function linhaColuna(lat, lng) {
    return [
        Math.floor(lat / config.tamanhoCelulaGrau),
        Math.floor(lng / config.tamanhoCelulaGrau)
    ];
}

function criarGrade(postos) {
    const grade = new Map();

    for (const posto of postos) {
        if (!coordenadasValidas(posto.lat, posto.lng)) continue;

        const [linha, coluna] = linhaColuna(posto.lat, posto.lng);
        const chave = chaveCelula(linha, coluna);

        if (!grade.has(chave)) grade.set(chave, []);
        grade.get(chave).push(posto);
    }

    return grade;
}

// Procura a data de coleta mais recente entre todos os produtos (formato dd-mm-aaaa)
function dataColetaMaisRecente() {
    let maisRecente = null;

    for (const posto of postosANP) {
        for (const produto of posto.PRODUTOS ?? []) {
            const [dia, mes, ano] = String(produto.dt_coleta ?? '').split('-').map(Number);
            if (!dia || !mes || !ano) continue;

            const data = new Date(ano, mes - 1, dia);
            if (!maisRecente || data > maisRecente) maisRecente = data;
        }
    }

    return maisRecente ? maisRecente.toLocaleDateString('pt-BR') : '';
}

export async function carregarANP() {
    try {
        const res = await fetch(config.caminhoANP);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        postosANP = await res.json();
        gradeANP = criarGrade(postosANP);
        dataColetaANP = dataColetaMaisRecente();
        erroANP = false;
        console.info(`Preços carregados: ${postosANP.length} postos.`);
    } catch (erro) {
        console.warn('Não foi possível carregar os preços.', erro);
        postosANP = [];
        gradeANP = new Map();
        erroANP = true;
    }
}

/* ========================================
   LOGOS DAS BANDEIRAS
   ======================================== */
export async function carregarLogos() {
    try {
        const res = await fetch(config.caminhoBandeiras);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        bandeirasLogo = await res.json();
    } catch (erro) {
        console.warn('Não foi possível carregar os logos.', erro);
        bandeirasLogo = {};
    }
}

/* ========================================
   DADOS DO OPENSTREETMAP (ARQUIVO SALVO)
   ======================================== */
export async function carregarOsm() {
    try {
        const res = await fetch(config.caminhoOsm);
        if (!res.ok) throw new Error(`Status ${res.status}`);

        elementosOsm = (await res.json()).elements;
        console.info(`Dados do OSM carregados: ${elementosOsm.length} elementos.`);
    } catch (erro) {
        console.warn('Não foi possível carregar o arquivo do OSM.', erro);
        elementosOsm = null;
    }
}

/* ========================================
   CRUZAMENTO OSM ↔ ANP
   ======================================== */
function encontrarPorDistancia(lat, lng) {
    const [linha, coluna] = linhaColuna(lat, lng);
    let melhor = null;
    let menorDistancia = Infinity;

    // Confere a célula do posto e as 8 vizinhas
    for (let dl = -1; dl <= 1; dl++) {
        for (let dc = -1; dc <= 1; dc++) {
            const candidatos = gradeANP.get(chaveCelula(linha + dl, coluna + dc)) ?? [];

            for (const posto of candidatos) {
                const distancia = calcularDistancia(lat, lng, posto.lat, posto.lng);

                if (distancia <= config.toleranciaKm && distancia < menorDistancia) {
                    menorDistancia = distancia;
                    melhor = posto;
                }
            }
        }
    }

    return melhor;
}

function encontrarPorNome(nomeOsm) {
    const alvo = normalizarNome(nomeOsm);
    if (!alvo) return null;

    return postosANP.find(function (posto) {
        return nomesCombinam(alvo, normalizarNome(posto.FANTASIA)) ||
            nomesCombinam(alvo, normalizarNome(posto['RAZÃO']));
    }) ?? null;
}

function encontrarPrecoANP(lat, lng, nomeOsm) {
    if (postosANP.length === 0 || !coordenadasValidas(lat, lng)) return null;

    return encontrarPorDistancia(lat, lng) ?? encontrarPorNome(nomeOsm);
}

// Converte elementos do OSM em postos com distância e preço ANP.
// origem = { lat, lng } do ponto buscado pelo usuário
export function processarElementos(elementos, origem) {
    const postos = [];

    for (const elemento of elementos) {
        const lat = elemento.type === 'node' ? elemento.lat : elemento.center?.lat;
        const lng = elemento.type === 'node' ? elemento.lon : elemento.center?.lon;

        if (!coordenadasValidas(lat, lng)) continue;

        const distancia = calcularDistancia(origem.lat, origem.lng, lat, lng);
        if (distancia > config.raioMaximoKm) continue;

        postos.push({
            ...elemento,
            lat,
            lng,
            distancia,
            dadosPreco: encontrarPrecoANP(lat, lng, elemento.tags?.name)
        });
    }

    // Ordenação padrão: sempre pela distância
    postos.sort(function (a, b) {
        return a.distancia - b.distancia;
    });

    return removerDuplicados(postos);
}

// Remove pins muito próximos com o mesmo nome (ex.: node e way do mesmo posto no OSM)
function removerDuplicados(postos) {
    const mantidos = [];

    for (const posto of postos) {
        const nome = normalizarNome(nomeDoPosto(posto));

        const jaExiste = mantidos.some(function (outro) {
            return calcularDistancia(posto.lat, posto.lng, outro.lat, outro.lng) <= config.distanciaDuplicadoKm &&
                nomesCombinam(nome, normalizarNome(nomeDoPosto(outro)));
        });

        if (!jaExiste) mantidos.push(posto);
    }

    return mantidos;
}

/* ========================================
   NOMINATIM (transforma endereço em coordenada)
   ======================================== */
export async function consultarNominatim(termo, limite) {
    const params = new URLSearchParams({
        format: 'json',
        limit: limite,
        countrycodes: 'br',
        q: termo
    });

    const res = await fetch(`${config.urlNominatim}?${params}`);
    if (!res.ok) throw new Error(`Status ${res.status}`);

    return res.json();
}