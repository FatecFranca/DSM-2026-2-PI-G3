'use strict';

/* ========================================
   CONFIGURAÇÃO
   ======================================== */
export const config = {
    raioPadraoKm: 5,              // raio selecionado ao abrir a página
    raioMaximoKm: 15,             // raio máximo considerado; o filtro reduz na tela
    toleranciaKm: 0.15,           // distância máxima entre posto OSM e posto ANP
    tamanhoCelulaGrau: 0.005,     // ~500 m, tamanho das células do índice da ANP
    minCaracteresNome: 12,        // evita casar nomes genéricos como "POSTO"
    distanciaDuplicadoKm: 0.03,   // 30 m: pins próximos com nome igual são o mesmo posto
    minCaracteresBusca: 3,
    atrasoAutocompleteMs: 1000,
    caminhoANP: './dados/json/postos_com_coordenadas.json',
    caminhoOsm: './dados/json/osm_BR.json',
    caminhoBandeiras: './dados/json/bandeiras.json',
    urlNominatim: 'https://nominatim.openstreetmap.org/search',
    urlTiles: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    aliasesBandeiras: { SHELL: 'RAIZEN', BR: 'VIBRA', PETROBRAS: 'VIBRA' },
    textosInfo: {
        perfil: ['Perfil', 'A busca está disponível sem cadastro. O projeto ainda não possui autenticação de usuários.']
    }
};

/* ========================================
   TEXTO
   ======================================== */
export function normalizarNome(texto) {
    return String(texto ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')  // remove acentos
        .toUpperCase()
        .replace(/[^A-Z0-9 ]/g, ' ')      // remove pontuação
        .replace(/\s+/g, ' ')
        .trim();
}

export function nomesCombinam(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;

    // Contenção só por palavras inteiras e com nome suficientemente longo
    const [curto, longo] = a.length <= b.length ? [a, b] : [b, a];
    return curto.length >= config.minCaracteresNome &&
        ` ${longo} `.includes(` ${curto} `);
}

// Primeira letra maiúscula e o restante minúsculo (ex.: "AVENIDA BRASIL" -> "Avenida brasil")
export function capitalizarTexto(texto) {
    return String(texto ?? '')
        .trim()
        .toLowerCase()
        .replace(/(^|\s)(\S)/g, (_, espaco, letra) => espaco + letra.toUpperCase());
}

/* ========================================
   BANDEIRAS E COMBUSTÍVEIS
   ======================================== */
// Identificador único da bandeira: aplica os aliases (SHELL -> RAIZEN, BR -> VIBRA)
export function chaveBandeira(nome) {
    const chave = normalizarNome(nome || 'SEM BANDEIRA');
    return config.aliasesBandeiras[chave] || chave;
}

// Bandeira da ANP quando existe; senão, a tag brand do OSM
export function bandeiraDoPosto(posto) {
    return posto.dadosPreco?.BANDEIRA || posto.tags?.brand || '';
}

// Classe da bolinha de cada combustível (gasolina, etanol ou diesel)
export function classeCombustivel(nome) {
    const n = normalizarNome(nome);

    if (n.includes('GASOLINA')) return 'gasolina';
    if (n.includes('ETANOL')) return 'etanol';
    if (n.includes('DIESEL')) return 'diesel';

    return '';
}

// Separa as variações sem mudar as cores dos combustíveis
export function tipoCombustivel(nome) {
    const n = normalizarNome(nome);

    if (n.includes('GASOLINA') && n.includes('ADITIVADA')) return 'gasolina-aditivada';
    if (n.includes('DIESEL') && /S\s*10\b/.test(n)) return 'diesel-s10';
    if (n.includes('DIESEL') && /S\s*500\b/.test(n)) return 'diesel-s500';

    return classeCombustivel(nome);
}

/* ========================================
   INFORMAÇÕES DO POSTO
   ======================================== */
export function nomeDoPosto(posto) {
    const nome = posto.tags?.name
        || posto.dadosPreco?.FANTASIA
        || posto.dadosPreco?.['RAZÃO']
        || 'Posto de combustível';

    return capitalizarTexto(nome);
}

export function enderecoDoPosto(posto) {
    const p = posto.dadosPreco;

    if (p) {
        return capitalizarTexto(`${p.ENDEREÇO || ''}, ${p.NÚMERO || ''} - ${p.BAIRRO || ''}, ${p.MUNICÍPIO || ''}`);
    }

    const tags = posto.tags || {};
    const partes = [tags['addr:street'], tags['addr:housenumber'], tags['addr:city']].filter(Boolean);

    return partes.length > 0 ? capitalizarTexto(partes.join(', ')) : 'Endereço não informado';
}

export function precoDoCombustivel(posto, combustivel) {
    const produto = posto.dadosPreco?.PRODUTOS?.find(function (p) {
        return p.nome === combustivel || tipoCombustivel(p.nome) === combustivel;
    });
    return produto ? Number(produto.preco) : null;
}

/* ========================================
   FILTROS E ORDENAÇÃO
   ======================================== */
// filtros = { raioKm, bandeira, combustiveis, apenasAnp }
export function passaFiltros(posto, filtros) {
    const temAnp = Boolean(posto.dadosPreco);

    if (posto.distancia > filtros.raioKm) return false;

    if (temAnp && !(posto.dadosPreco.PRODUTOS ?? []).some(p => filtros.combustiveis.includes(tipoCombustivel(p.nome)))) return false;

    if (filtros.apenasAnp && !temAnp) return false;

    if (filtros.bandeira && chaveBandeira(bandeiraDoPosto(posto)) !== chaveBandeira(filtros.bandeira)) return false;

    return true;
}

// Ordena pelo preço do combustível; postos sem preço ficam no fim, ordenados por distância
export function ordenarPorPreco(postos, combustivel) {
    return [...postos].sort(function (a, b) {
        const precoA = precoDoCombustivel(a, combustivel);
        const precoB = precoDoCombustivel(b, combustivel);

        if (precoA === null && precoB === null) return a.distancia - b.distancia;
        if (precoA === null) return 1;
        if (precoB === null) return -1;

        return precoA - precoB || a.distancia - b.distancia;
    });
}