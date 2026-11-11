'use strict';


const PARAMETROS = ['lat', 'lng', 'raio', 'comb', 'anp'];

function montarQuery() {
    const atual = new URLSearchParams(window.location.search);
    const saida = new URLSearchParams();

    for (const nome of PARAMETROS) {
        if (atual.has(nome)) saida.set(nome, atual.get(nome));
    }

    return saida.toString();
}

function atualizarLinks() {
    const query = montarQuery();
    const sufixo = query ? `?${query}` : '';

    const postos = document.getElementById('navPostos');
    if (postos) postos.href = `../index.html${sufixo}`;

    const sobre = document.getElementById('navSobre');
    if (sobre) sobre.href = `./sobre.html${sufixo}`;

    const dicas = document.getElementById('navDicas');
    if (dicas) dicas.href = `./dicas.html${sufixo}`;
}

atualizarLinks();