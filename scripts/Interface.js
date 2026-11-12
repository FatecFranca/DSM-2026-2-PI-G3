'use strict';

import {
    config, normalizarNome, capitalizarTexto, chaveBandeira, bandeiraDoPosto,
    classeCombustivel, tipoCombustivel, nomeDoPosto, enderecoDoPosto
} from './Regras.js';
import { bandeirasLogo } from './Dados.js';

/* ========================================
   UTILITÁRIOS DE PÁGINA
   ======================================== */
export const $ = (id) => document.getElementById(id);

export function setStatus(mensagem) {
    $('status').textContent = mensagem;
}

const ESCAPES_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Escapa dados externos (ANP, OpenStreetMap, bandeiras) antes de inserir no HTML
const escaparHtml = (valor) => String(valor ?? '').replace(/[&<>"']/g, (c) => ESCAPES_HTML[c]);

const formatarDistancia = (km) => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

const formatarPreco = (valor) => `R$ ${Number(valor).toFixed(2).replace('.', ',')}`;

// Abre o diálogo; se o navegador não tiver showModal, usa o atributo open
export function abrirDialog(dialog) {
    if (typeof dialog.showModal === 'function') {
        dialog.showModal();
    } else {
        dialog.setAttribute('open', '');
    }
}

export function fecharDialog(dialog) {
    if (typeof dialog.close === 'function') {
        dialog.close();
    } else {
        dialog.removeAttribute('open');
    }
}

/* ========================================
   COMBUSTÍVEIS (LEITURA DA TELA)
   ======================================== */
// Padrão quando nada está marcado: gasolina, aditivada e etanol
export const COMBUSTIVEIS_PADRAO = ['gasolina', 'gasolina-aditivada', 'etanol'];

// Combustíveis marcados nas checkboxes ([data-fuel])
export function combustiveisSelecionados() {
    return [...document.querySelectorAll('[data-fuel]:checked')].map(input => input.dataset.fuel);
}

// Os marcados ou, se nenhum estiver marcado, o padrão
export function combustiveisEfetivos() {
    const selecionados = combustiveisSelecionados();
    if (selecionados.length > 0) return selecionados;

    return [...COMBUSTIVEIS_PADRAO];
}

// Diesel e os demais combustíveis não podem ficar marcados juntos
export function ehDiesel(tipo) {
    return tipo.startsWith('diesel');
}

/* ========================================
   LOGOS E CORES
   ======================================== */
export function logoBandeira(nome) {
    const chave = normalizarNome(nome || 'SEM BANDEIRA');
    const chaveReal = config.aliasesBandeiras[chave] || chave;
    const dados = bandeirasLogo[chaveReal];

    if (dados?.logo) {
        const fundo = dados.fundoLogo ? ` style="background:${escaparHtml(dados.fundoLogo)}"` : '';
        return `<span class="logo-original"${fundo}><img src="${escaparHtml(dados.logo)}" alt="Logo ${escaparHtml(capitalizarTexto(nome))}" loading="lazy"></span>`;
    }

    const classe = chave === 'SEM BANDEIRA' ? 'selo-sem-bandeira' : 'selo-bandeira';
    const rotulo = chave === 'SEM BANDEIRA' ? 'Sem bandeira' : nome;

    return `<span class="${classe}">${escaparHtml(capitalizarTexto(rotulo))}</span>`;
}

// Cor do topo do card, vinda do bandeiras.json
export function fundoTopoDoPosto(posto) {
    const chave = normalizarNome(bandeiraDoPosto(posto) || 'SEM BANDEIRA');
    const chaveReal = config.aliasesBandeiras[chave] || chave;

    return bandeirasLogo[chaveReal]?.fundoTopo || '#b1b1b1';
}

/* ========================================
   MAPA
   ======================================== */
let map = null;
let marcadorUsuario = null;
let circuloBusca = null;

// Cria o mapa somente quando o usuário define o local
export function criarMapa(origem) {
    if (typeof L === 'undefined') {
        setStatus('Não foi possível carregar o mapa. Verifique sua conexão e recarregue a página.');
        return false;
    }

    if (map) map.remove();

    map = L.map('map').setView([origem.lat, origem.lng], 14);

    L.tileLayer(config.urlTiles, {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    const iconeUsuario = L.divIcon({
        className: 'pin-usuario',
        html: '<span></span>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
        popupAnchor: [0, -12]
    });

    marcadorUsuario = L.marker([origem.lat, origem.lng], { icon: iconeUsuario }).addTo(map);
    marcadorUsuario.bindPopup('<strong>Você está aqui</strong>').openPopup();

    // Renderizador com margem: desenha o círculo também fora da área visível,
    // para que ele não suma enquanto o mapa é arrastado
    const renderizador = L.svg({ padding: 1 });

    circuloBusca = L.circle([origem.lat, origem.lng], {
        radius: Number($('selRaio').value) * 1000,
        stroke: false,
        fillColor: '#92d945',
        fillOpacity: 0.23,
        renderer: renderizador
    }).addTo(map);

    map.fitBounds(circuloBusca.getBounds(), { padding: [20, 20] });
    return true;
}

// Remove os pins de postos, mantendo o marcador do usuário
export function limparMarcadores() {
    if (!map) return;

    map.eachLayer(function (camada) {
        if (camada instanceof L.Marker && camada !== marcadorUsuario) {
            map.removeLayer(camada);
        }
    });
}

export function limparResultados() {
    limparMarcadores();
    $('postos').innerHTML = '';
}

export function mostrarMensagemLista(mensagem) {
    $('postos').innerHTML = `<p>${mensagem}</p>`;
}

// Mostra o valor do raio num balão, move o preenchimento do slider e atualiza o círculo
export function atualizarBalaoRaio() {
    const slider = $('selRaio');
    const min = Number(slider.min);
    const max = Number(slider.max);
    const valor = Number(slider.value);

    // Posição em porcentagem, com correção para a largura do controle (16 px)
    const percentual = (valor - min) / (max - min) * 100;
    const balao = $('balao-raio');

    balao.textContent = `${valor} km`;
    balao.style.left = `calc(${percentual}% + ${8 - percentual * 0.16}px)`;
    slider.style.setProperty('--progress', `${percentual}%`);

    if (circuloBusca) circuloBusca.setRadius(valor * 1000);
}

/* ========================================
   PINS E CARDS
   ======================================== */
// Produto mostrado no pin; só existe quando um único combustível está escolhido
function produtoNoMapa(posto, combustivel) {
    if (!combustivel) return null;

    const produtos = (posto.dadosPreco?.PRODUTOS ?? []).filter(function (produto) {
        return tipoCombustivel(produto.nome) === combustivel;
    });

    return produtos[0] || null;
}

export function adicionarMarcador(posto, combustivel) {
    if (!map) return;

    const produto = produtoNoMapa(posto, combustivel);

    const icone = L.divIcon({
        className: 'pin-preco',
        html: '<span></span>',
        iconSize: [17, 23],
        iconAnchor: [8, 23],
        popupAnchor: [0, -26]
    });

    const marcador = L.marker([posto.lat, posto.lng], {
        icon: icone,
        title: produto
            ? `${capitalizarTexto(produto.nome)}: ${formatarPreco(produto.preco)} — coleta: ${produto.dt_coleta}`
            : nomeDoPosto(posto)
    })
        .addTo(map)
        .bindPopup(`
            <div class="popup-posto">
                <strong>⛽ ${escaparHtml(nomeDoPosto(posto))}</strong><br>
                ${escaparHtml(enderecoDoPosto(posto))}<br><br>
                <strong>${escaparHtml(formatarDistancia(posto.distancia))}</strong>
            </div>
        `);

    if (produto) {
        marcador.bindTooltip(formatarPreco(produto.preco), {
            permanent: true,
            direction: 'right',
            offset: [4, -12],
            className: 'preco-mapa',
            opacity: 1
        });
    }
}

function deParaNomeExibicao(nome) {
    const n = normalizarNome(nome);

    if (n === 'GASOLINA COMUM') return 'Gasolina C.';
    if (n === 'GASOLINA ADITIVADA') return 'Gasolina A.';

    return capitalizarTexto(nome);
}

function htmlProdutos(posto, combustivel) {
    if (!posto.dadosPreco) {
        return '<p class="sem-preco">Preço da ANP não associado a este posto.</p>';
    }

    const selecionados = combustiveisEfetivos();
    const tiposDisponiveis = [...document.querySelectorAll('[data-fuel]')].map(input => input.dataset.fuel);

    const produtos = (posto.dadosPreco.PRODUTOS ?? []).filter(function (p) {
        const tipo = tipoCombustivel(p.nome);
        return !tiposDisponiveis.includes(tipo) || selecionados.includes(tipo);
    });

    if (produtos.length === 0) {
        return '<p class="sem-preco">Preço não informado</p>';
    }

    const itens = produtos.map(function (p) {
        return `
        <li>
            <span class="nome-combustivel ${classeCombustivel(p.nome)}">${escaparHtml(deParaNomeExibicao(p.nome))}</span>
            <span class="preco">${formatarPreco(p.preco)}</span>
            <span class="data-coleta">Coleta: ${escaparHtml(p.dt_coleta.replace(/-/g, '/').replace('2026', '26'))}</span>
        </li>`;
    }).join('');

    return `<ul class="lista-produtos">${itens}</ul>`;
}

export function adicionarCard(posto, combustivel) {
    const urlMapas = `https://www.google.com/maps/search/?api=1&query=${posto.lat},${posto.lng}`;
    const nome = nomeDoPosto(posto);

    const card = document.createElement('div');
    card.className = 'posto';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Ver ${nome} no mapa`);

    card.addEventListener('keydown', function (evento) {
        if (evento.target !== card) return;

        if (evento.key === 'Enter' || evento.key === ' ') {
            evento.preventDefault();
            card.click();
        }
    });

    card.innerHTML = `
        <div class="posto-topo" style="background:${escaparHtml(fundoTopoDoPosto(posto))}">
            <span class="logo-marca">${logoBandeira(bandeiraDoPosto(posto))}</span>
        </div>
        <div class="posto-cabecalho">
            <div class="posto-info-principal">
                <img src="./img/icones/bomba_cinza.svg" alt="" class="gas-icon">
                <div class="texto-titulo-endereco">
                    <h3>${escaparHtml(nome)}</h3>
                    <p class="endereco">${escaparHtml(enderecoDoPosto(posto))}</p>
                </div>
            </div>
            <div class="posto-cabecalho-dir">
                <img src="./img/icones/pin_cinza.svg" alt="" class="pin-icon">
                <span>${escaparHtml(formatarDistancia(posto.distancia))}</span>
            </div>
        </div>
        ${htmlProdutos(posto, combustivel)}
        <a class="btn-rota" href="${escaparHtml(urlMapas)}" target="_blank" rel="noopener noreferrer">
            Abrir no Google Maps
        </a>
    `;

    card.querySelector('a').addEventListener('click', function (evento) {
        evento.stopPropagation();
    });

    card.addEventListener('click', function () {
        if (map) map.setView([posto.lat, posto.lng], 17);
    });

    $('postos').appendChild(card);
}

export function desenharPostos(postos, combustivel) {
    for (const posto of postos) {
        adicionarMarcador(posto, combustivel);
        adicionarCard(posto, combustivel);
    }
}

/* ========================================
   MENU DE BANDEIRAS E AVISOS
   ======================================== */
export function atualizarBandeiras(postos, aoMudar) {
    const porChave = new Map();

    for (const posto of postos) {
        const nome = bandeiraDoPosto(posto);
        if (!nome) continue;

        const chave = chaveBandeira(nome);
        if (!porChave.has(chave)) porChave.set(chave, nome);
    }

    const bandeiras = [...porChave.values()].sort();
    const select = $('selBandeira');
    const escolhida = select.value;

    select.innerHTML = '';
    select.add(new Option('Todas as bandeiras', ''));

    for (const bandeira of bandeiras) {
        select.add(new Option(bandeira, bandeira));
    }

    select.value = bandeiras.includes(escolhida) ? escolhida : '';

    const lista = $('listaBandeiras');
    lista.innerHTML = '';

    for (const nome of ['', ...bandeiras]) {
        const botao = document.createElement('button');
        botao.type = 'button';
        botao.innerHTML = (nome ? `<span class="mini-bandeira">${logoBandeira(nome)}</span>` : '') +
            escaparHtml(nome ? capitalizarTexto(nome) : 'Todas as bandeiras');

        botao.addEventListener('click', function () {
            select.value = nome;
            $('menuBandeiras').open = false;
            aoMudar();
        });

        lista.appendChild(botao);
    }
}

export function atualizarRotuloBandeira() {
    const bandeira = $('selBandeira').value;

    $('bandeiraEscolhida').innerHTML = bandeira
        ? `<span class="mini-bandeira">${logoBandeira(bandeira)}</span>${escaparHtml(capitalizarTexto(bandeira))}`
        : 'Todas as bandeiras';
}

export function atualizarAvisoMapa(combustiveis) {
    $('avisoMapa').textContent = combustiveis.length === 1
        ? `Preço no mapa: ${capitalizarTexto(combustiveis[0].replace(/-/g, ' '))}.`
        : 'Para ver preços no mapa, marque apenas um combustível.';
}

/* ========================================
   AUTOCOMPLETE
   ======================================== */
export function limparSugestoes() {
    $('sugestoes').innerHTML = '';
    $('sugestoesEndereco').innerHTML = '';
}

export function mostrarSugestoes(locais, aoEscolher, campo) {
    const caixa = $(campo.id === 'welcomeEndereco' ? 'sugestoesEndereco' : 'sugestoes');
    caixa.innerHTML = '';

    const termoDigitado = campo.value.trim();

    for (const local of locais) {
        const item = document.createElement('div');
        item.className = 'sugestao-item';

        if (termoDigitado) {
            // 1. Quebra o texto digitado em várias palavras, ignorando espaços vazios
            const palavras = termoDigitado.split(/\s+/).filter(Boolean);

            // Escapa caracteres especiais de cada palavra para evitar erros na RegEx
            const palavrasEscapadas = palavras.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

            // 2. Cria uma Regex que busca qualquer uma das palavras digitadas (ignorando maiúsculas/minúsculas e acentos)
            const regex = new RegExp(`(${palavrasEscapadas.join('|')})`, 'gi');

            // 3. Substitui todas as ocorrências encontradas envolvendo-as com <strong>
            item.innerHTML = local.display_name.replace(regex, '<strong>$1</strong>');
        } else {
            item.textContent = local.display_name;
        }

        item.addEventListener('click', function () {
            aoEscolher(local, campo);
        });
        caixa.appendChild(item);
    }
}

/* ========================================
   BOAS-VINDAS, INFORMAÇÕES E LAYOUT
   ======================================== */
// Copia as escolhas do diálogo inicial (ou da URL) para os controles da página
export function aplicarPreferenciasIniciais(preferencias) {
    const raio = preferencias?.raio ?? $('welcomeRaio').value;
    const combustiveis = preferencias?.combustiveis ?? [$('welcomeCombustivel').value];
    const apenasAnp = preferencias?.apenasAnp ?? false;

    $('selRaio').value = raio;
    atualizarBalaoRaio();

    document.querySelectorAll('[data-fuel]').forEach(function (input) {
        input.checked = combustiveis.includes(input.dataset.fuel);
    });

    $('chkApenasANP').checked = apenasAnp;
}

export function abrirInfo(chave) {
    const [titulo, texto] = config.textosInfo[chave];

    $('infoTitle').textContent = titulo;
    $('infoText').textContent = texto;
    abrirDialog($('infoDialog'));
}

export function alternarFiltros() {
    const botao = $('toggleFiltros');
    const recolhido = $('app').classList.toggle('collapsed');

    botao.innerHTML = recolhido ? `<img src="./img/icones/estender.svg" alt="">` : `<img src="./img/icones/recolher.svg" alt="">`;
    botao.setAttribute('aria-expanded', String(!recolhido));
    botao.setAttribute('aria-label', recolhido ? 'Expandir filtros' : 'Recolher filtros');

    if (map) map.invalidateSize();
}