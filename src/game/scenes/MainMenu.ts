import { Scene, GameObjects } from 'phaser';

export class MainMenu extends Scene
{
    background: GameObjects.Image;
    logo: GameObjects.Image;
    title: GameObjects.Text;

    constructor ()
    {
        super('MainMenu');
    }

    create ()
    {
        this.background = this.add.image(512, 384, 'background');

        this.logo = this.add.image(512, 300, 'logo');

        this.title = this.add.text(512, 400, 'Main Menu', {
            fontFamily: 'Arial Black', fontSize: 38, color: '#ffffff',
            stroke: '#000000', strokeThickness: 8,
            align: 'center'
        }).setOrigin(0.5);

        // this.input.once('pointerdown', () => {

        //     this.scene.start('Game');

        // });

        // Button to nav to Game scene
        const gameButton = this.add.text(512, 500, 'Start Game', {
            fontFamily: 'Arial', fontSize: 24, color: '#00ff00',
            backgroundColor: '#000000'
        }).setOrigin(0.5).setPadding(10).setInteractive({ useHandCursor: true });

        gameButton.on('pointerdown', () => {
            this.scene.start('Game');
        });

        // Button to nav to Map Gen test scene
        const mapGenButton = this.add.text(512, 550, 'Go to Map Gen Test', {
            fontFamily: 'Arial', fontSize: 24, color: '#00ff00',
            backgroundColor: '#000000'
        }).setOrigin(0.5).setPadding(10).setInteractive({ useHandCursor: true });

        
        mapGenButton.on('pointerdown', () => {
            console.log('Navigating to MapGenTest');
            this.scene.start('MapGenTest');
        });
    }
}
