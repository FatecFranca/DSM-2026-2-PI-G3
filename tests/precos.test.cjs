// Execute com: node tests/precos.test.cjs
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const raiz = path.resolve(__dirname, '..');
const elementos = new Map();

function elemento() {
    return {
        value: '', checked: false, children: [], textContent: '',
        style: { setProperty() {} }, classList: { toggle() {} },
        addEventListener() {}, setAttribute() {}, add(opcao) { this.children.push(opcao); },
        appendChild(filho) { this.children.push(filho); },
        set innerHTML(valor) { this.html = valor; this.children = []; },
        get innerHTML() {
            return this.html || this.textContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
    };
}
const combustiveis = ['gasolina', 'etanol', 'diesel', 'gasolina-aditivada', 'diesel-s10', 'diesel-s500'].map(function (nome) {
    return { dataset: { fuel: nome }, checked: true, addEventListener() {} };
});
const document = {
    getElementById(id) {
        if (!elementos.has(id)) elementos.set(id, elemento());
        return elementos.get(id);
    },
    createElement: elemento,
    querySelector(seletor) { return combustiveis.find(item => seletor.includes('"' + item.dataset.fuel + '"')); },
    querySelectorAll(seletor) {
        if (!seletor.includes('data-fuel')) return [];
        return seletor.includes(':checked') ? combustiveis.filter(item => item.checked) : combustiveis;
    },
    addEventListener() {}
};
const contexto = vm.createContext({
    document, console, Option: function (texto, valor) { this.text = texto; this.value = valor; },
    fetch: async function (arquivo) {
        return { ok: true, json: async () => JSON.parse(fs.readFileSync(path.join(raiz, arquivo), 'utf8')) };
    }
});
let codigo = fs.readFileSync(path.join(raiz, 'scripts/App.js'), 'utf8');
codigo = codigo.replace("import calcularDistancia from './Math.js';", fs.readFileSync(path.join(raiz, 'scripts/Math.js'), 'utf8').replace('export default calcularDistanciaHaversine', 'const calcularDistancia = calcularDistanciaHaversine;'));
codigo = codigo.replace('registrarEventos();', '');
codigo = codigo.replace('prontoDados = Promise.all([carregarANP(), carregarOsm(), carregarLogos()]);', '');
codigo = codigo.replace(/usarLocalizacao\(-20\.5216968[^\n]+/, '');
codigo = codigo.replace("$('welcome').showModal();", '');
vm.runInContext(codigo, contexto);

(async function () {
    await vm.runInContext('Promise.all([carregarANP(), carregarOsm(), carregarLogos()])', contexto);
    vm.runInContext("localUsuario = { lat: -20.5216968, lng: -47.4095364 }; $('selRaio').value = '5'; $('selOrdenacao').value = 'distancia'; postosEncontrados = processarElementos(elementosOsm); aplicarFiltros();", contexto);
    combustiveis.forEach(item => item.checked = false);
    vm.runInContext('aplicarFiltros()', contexto);
    assert.ok(elementos.get('postos').innerHTML.includes('Selecione um combustível'));
    combustiveis.forEach(item => item.checked = true);
    vm.runInContext('aplicarFiltros()', contexto);
    const postos = vm.runInContext('postosEncontrados', contexto);
    const franca = postos.filter(posto => posto.dadosPreco?.['MUNICÍPIO'] === 'FRANCA' && posto.distancia <= 5);
    assert.equal(franca.length, 16, 'Todos os 16 registros localizados de Franca precisam aparecer');
    assert.ok(franca.every(posto => posto.dadosPreco.precisao !== 'municipio'));
    const orquideas = franca.find(posto => posto.dadosPreco['RAZÃO'].includes('ORQUIDEAS'));
    assert.ok(orquideas, 'Posto da Av. Chico Julio precisa aparecer mesmo sem associação OSM');
    contexto.postoTeste = orquideas;
    assert.ok(vm.runInContext("logoBandeira('RAIZEN')", contexto).includes('img/bandeiras/raizen.svg'));
    assert.ok(vm.runInContext("logoBandeira('VIBRA')", contexto).includes('img/bandeiras/vibra.svg'));
    assert.ok(vm.runInContext("logoBandeira('BRANCA')", contexto).includes('Branca'));
    assert.ok(vm.runInContext("logoBandeira('Sem bandeira')", contexto).includes('Sem bandeira'));
    const html = vm.runInContext("htmlProdutos(postoTeste, '')", contexto);
    assert.ok(html.includes('R$ 6,64'));
    assert.ok(html.includes('R$ 3,94'));
    assert.ok(html.includes('R$ 7,49'));
    assert.ok(html.includes('26-10-2026'));
    const cards = elementos.get('postos').children;
    assert.ok(cards[0].innerHTML.includes('R$'), 'Os preços devem aparecer no card, não apenas nos dados');
    assert.ok(cards.some(card => card.innerHTML.includes('POSTO DAS ORQUIDEAS')));

    const bandeiras = [...new Set(franca.map(posto => posto.dadosPreco.BANDEIRA))].sort();
    assert.deepEqual(elementos.get('selBandeira').children.slice(1).map(opcao => opcao.value), bandeiras);
    elementos.get('selBandeira').value = bandeiras[0];
    vm.runInContext('aplicarFiltros()', contexto);
    assert.equal(elementos.get('selBandeira').value, bandeiras[0]);
    assert.deepEqual(elementos.get('selBandeira').children.slice(1).map(opcao => opcao.value), bandeiras, 'Selecionar uma bandeira não esconde as demais');
    elementos.get('selBandeira').value = bandeiras.find(bandeira => !franca.some(posto => posto.distancia === 0 && posto.dadosPreco.BANDEIRA === bandeira));
    elementos.get('selRaio').value = '0';
    vm.runInContext('aplicarFiltros()', contexto);
    assert.equal(elementos.get('selBandeira').value, '', 'Limpa a bandeira quando sai do raio');
    elementos.get('selRaio').value = '5';
    vm.runInContext('aplicarFiltros()', contexto);
    console.log('OK: bandeiras limitadas à busca e atualizadas ao mudar o raio.');

    combustiveis.forEach(item => item.checked = false);
    combustiveis[0].checked = true;
    assert.equal(vm.runInContext("produtoNoMapa(postoTeste, '').preco", contexto), 6.64);
    combustiveis[0].checked = false;
    combustiveis[1].checked = true;
    assert.equal(vm.runInContext("produtoNoMapa(postoTeste, '').preco", contexto), 3.94);
    const etiquetas = [];
    contexto.L = {
        divIcon(opcoes) { return opcoes; },
        marker() {
            return {
                addTo() { return this; },
                bindPopup() { return this; },
                bindTooltip(texto, opcoes) { etiquetas.push({ texto, opcoes }); return this; }
            };
        }
    };
    vm.runInContext("map = {}; adicionarMarcador(postoTeste, ''); map = null;", contexto);
    assert.equal(etiquetas[0].texto, 'R$ 3,94');
    assert.equal(etiquetas[0].opcoes.permanent, true);
    combustiveis[2].checked = true;
    assert.equal(vm.runInContext("produtoNoMapa(postoTeste, '')", contexto), null, 'Dois combustíveis não mostram etiqueta');
    vm.runInContext("map = {}; adicionarMarcador(postoTeste, ''); map = null;", contexto);
    assert.equal(etiquetas.length, 1, 'Etanol e diesel juntos não criam etiqueta');
    assert.equal(vm.runInContext("produtoNoMapa({ dadosPreco: null }, '')", contexto), null);
    assert.equal(vm.runInContext("produtoNoMapa(postoTeste, 'DIESEL S10').preco", contexto), 7.49);
    combustiveis[0].checked = true;
    combustiveis[1].checked = false;
    combustiveis[2].checked = false;
    const gasolina = vm.runInContext("htmlProdutos(postoTeste, '')", contexto);
    assert.ok(gasolina.includes('R$ 6,64'));
    assert.ok(!gasolina.includes('R$ 3,94'));
    assert.ok(!gasolina.includes('R$ 7,49'));
    assert.equal(vm.runInContext('processarElementos([]).filter(p => p.distancia <= 5).length', contexto), 16, 'ANP funciona sem OSM');
    assert.ok(postos.filter(posto => !posto.dadosPreco).length > 0, 'OSM mantém postos adicionais sem inventar preços');
    vm.runInContext("$('chkApenasANP').checked = true; aplicarFiltros();", contexto);
    assert.equal(elementos.get('postos').children.length, 16);
    vm.runInContext("$('selOrdenacao').value = 'preco'; aplicarFiltros();", contexto);
    const valores = elementos.get('postos').children.map(card => Number(card.innerHTML.match(/R\$ (\d+,\d+)/)[1].replace(',', '.')));
    assert.deepEqual(valores, [...valores].sort((a, b) => a - b));
    await vm.runInContext("elementosOsm = null; prontoDados = Promise.resolve(); buscarPostos();", contexto);
    assert.equal(elementos.get('postos').children.length, 16);
    assert.ok(elementos.get('status').textContent.includes('OSM indisponível'));
    contexto.fetch = async () => ({ ok: false, status: 404 });
    contexto.console = { ...console, warn() {} };
    await vm.runInContext('carregarANP()', contexto);
    await vm.runInContext('buscarPostos()', contexto);
    assert.ok(elementos.get('status').textContent.includes('Não foi possível carregar a base'));
    const raios = [];
    contexto.registrarRaio = valor => raios.push(valor);
    vm.runInContext('circuloBusca = { setRadius: registrarRaio };', contexto);
    for (const km of [5, 10, 15]) {
        elementos.get('selRaio').value = String(km);
        vm.runInContext('atualizarBalaoRaio()', contexto);
        assert.equal(elementos.get('balao-raio').textContent, km + ' km');
    }
    assert.deepEqual(raios, [5000, 10000, 15000]);
    const pagina = fs.readFileSync(path.join(raiz, 'index.html'), 'utf8');
    assert.equal((pagina.match(/id="btnLocalizacao"/g) || []).length, 1);
    assert.ok(pagina.indexOf('id="btnLocalizacao"') < pagina.indexOf('<div class="advanced">'));
    assert.ok(pagina.indexOf('id="btnEndereco"') > pagina.indexOf('id="chkApenasANP"'));
    assert.equal((pagina.match(/data-fuel=/g) || []).length, 6);
    assert.ok(!pagina.includes('selCombustivel'));
    assert.ok(!/data-fuel="[^"]+" checked/.test(pagina));
    assert.ok(pagina.indexOf('id="selOrdenacao"') > pagina.indexOf('</aside>'));
    combustiveis.forEach(item => item.checked = item.dataset.fuel === 'diesel-s10');
    const dieselS10 = vm.runInContext("htmlProdutos(postoTeste, '')", contexto);
    assert.ok(dieselS10.includes('diesel s10'));
    assert.ok(!dieselS10.includes('etanol'));
    assert.equal(vm.runInContext("produtoNoMapa(postoTeste, '').preco", contexto), 7.49);
    assert.equal(vm.runInContext("tipoCombustivel('GASOLINA ADITIVADA')", contexto), 'gasolina-aditivada');
    assert.equal(vm.runInContext("tipoCombustivel('DIESEL S500')", contexto), 'diesel-s500');
    console.log('OK: seis combustíveis independentes e Buscar no final.');
    console.log('OK: botão de localização visível e raios de 5, 10 e 15 km.');
    console.log('OK: 16 postos ANP de Franca, valores e datas reais nos cards, filtros, ordenação e funcionamento sem OSM.');
})().catch(function (erro) { console.error(erro); process.exitCode = 1; });
